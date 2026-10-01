#!/usr/bin/env bun
import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { sourceHash } from "./conversation-plan-worker";

const OWNER = "org.chopin.conversation-plan-run";
const COMMIT = "org.chopin.source-commit";
const LIMIT_MS = 180_000;

type Options = { image: string; postgresImage: string };
type Container = { name: string; id?: string };

export function options(args: string[]): Options {
	let values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		let flag = args[index]!;
		let value = args[index + 1];
		if (
			!["--image", "--postgres-image"].includes(flag) || values.has(flag)
			|| !value || !/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
		) {
			throw new Error("Use exactly --image <local tag> --postgres-image <local tag>");
		}
		values.set(flag, value);
	}
	if (values.size !== 2) throw new Error("Both prebuilt local image tags are required");
	return { image: values.get("--image")!, postgresImage: values.get("--postgres-image")! };
}

type Command = (
	args: string[],
	label: string,
	timeout?: number,
	optional?: boolean,
) => Promise<{ code: number; stdout: string; stderr: string }>;

async function dispose(
	container: Container,
	command: Command,
	inspect: (container: Container) => Promise<unknown>,
	uncertainCreations: Set<string>,
): Promise<{ name: string; absent: boolean }> {
	try {
		if (await inspect(container)) {
			await command(
				["docker", "stop", "--time", "8", container.id!],
				"Stop owned container",
				12_000,
				true,
			);
			await command(
				["docker", "rm", "--force", "--volumes", container.id!],
				"Remove owned container",
			);
		}
		let result = await command([
			"docker",
			"container",
			"ls",
			"--all",
			"--no-trunc",
			"--filter",
			container.id ? `id=${container.id}` : `name=^/${container.name}$`,
			"--format",
			"{{.ID}}",
		], "Verify owned container absent");
		return {
			name: container.name,
			absent: !result.stdout && !uncertainCreations.has(container.name),
		};
	} catch {
		return { name: container.name, absent: false };
	}
}

async function main(): Promise<void> {
	let selected = options(process.argv.slice(2));
	let root = await realpath(resolve(import.meta.dir, ".."));
	let nonce = randomBytes(16).toString("hex");
	let base = root;
	for (let part of ["e2e", "test-results", "conversation-plan"]) {
		base = join(base, part);
		await mkdir(base).catch(error => {
			if (error.code !== "EEXIST") throw error;
		});
		if (await realpath(base) !== base) throw new Error("Report parent must not contain symlinks");
	}
	let reports = join(base, nonce);
	await mkdir(reports, { mode: 0o700 });
	let db: Container = { name: `chopin-cp-db-${nonce}` };
	let app: Container = { name: `chopin-cp-app-${nonce}` };
	let current: Subprocess | undefined;
	let creating: string | undefined;
	let uncertainCreations = new Set<string>();
	let interrupted = false;
	let cleaning = false;
	let deadline = Date.now() + LIMIT_MS;
	let phases: string[] = [];
	let cleanup: { name: string; absent: boolean }[] = [];
	let exit = 1;
	let failure: string | undefined;
	let env = { PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin" };
	let onSignal = () => {
		interrupted = true;
		if (!cleaning) {
			if (creating) uncertainCreations.add(creating);
			current?.kill("SIGTERM");
		}
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	async function command(args: string[], label: string, timeout = 15_000, optional = false) {
		if (!cleaning && (interrupted || Date.now() >= deadline)) {
			throw new Error("Run interrupted or deadline exceeded");
		}
		let child = Bun.spawn(args, {
			cwd: root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		current = child;
		creating = args[0] === "docker" && args[1] === "create"
			? args[args.indexOf("--name") + 1]
			: undefined;
		let timer = setTimeout(() => {
			if (creating) uncertainCreations.add(creating);
			child.kill("SIGKILL");
		}, cleaning ? timeout : Math.max(1, Math.min(timeout, deadline - Date.now())));
		try {
			let [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (!optional && code !== 0) throw new Error(`${label} failed`);
			if (!cleaning && interrupted) throw new Error("Run interrupted");
			return { code, stdout: stdout.trim(), stderr };
		} finally {
			clearTimeout(timer);
			current = undefined;
			creating = undefined;
		}
	}

	async function inspect(container: Container) {
		if (!container.id) {
			let result = await command([
				"docker",
				"container",
				"ls",
				"--all",
				"--no-trunc",
				"--filter",
				`name=^/${container.name}$`,
				"--format",
				"{{.ID}}",
			], "Locate owned container");
			if (!result.stdout) return undefined;
			if (!/^[a-f0-9]{64}$/.test(result.stdout)) throw new Error("Ambiguous container identity");
			container.id = result.stdout;
		}
		let result = await command([
			"docker",
			"container",
			"inspect",
			container.id,
		], "Inspect owned container");
		let [state] = JSON.parse(result.stdout);
		if (
			state.Id !== container.id || state.Name !== `/${container.name}`
			|| state.Config.Labels?.[OWNER] !== nonce
		) throw new Error("Container ownership mismatch");
		uncertainCreations.delete(container.name);
		return state;
	}

	try {
		let commit = (await command(["git", "rev-parse", "HEAD"], "Read source commit")).stdout;
		if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source commit");
		let dirty = await command(
			["git", "status", "--porcelain", "--untracked-files=all"],
			"Check source checkout",
		);
		if (dirty.stdout) throw new Error("A clean committed checkout is required");
		let image = JSON.parse(
			(await command([
				"docker",
				"image",
				"inspect",
				selected.image,
			], "Inspect prebuilt runtime image")).stdout,
		)[0];
		let postgres = JSON.parse(
			(await command([
				"docker",
				"image",
				"inspect",
				selected.postgresImage,
			], "Inspect prebuilt PostgreSQL image")).stdout,
		)[0];
		if (
			!/^sha256:[a-f0-9]{64}$/.test(image.Id)
			|| image.Config.Labels?.[COMMIT] !== commit || Object.keys(image.Config.Volumes || {}).length
		) throw new Error("Runtime image commit mismatch");
		if (
			!/^sha256:[a-f0-9]{64}$/.test(postgres.Id)
			|| !postgres.Config.Env?.includes("PG_MAJOR=17")
		) throw new Error("PostgreSQL 17 image required");
		phases.push("prebuilt-images-validated");
		let identity = `cp_${nonce}`;
		let password = randomBytes(32).toString("hex");
		let port = randomInt(20_000, 61_000);
		let url = `postgres://${identity}:${password}@127.0.0.1:${port}/${identity}?sslmode=disable`;
		let dbId = await command([
			"docker",
			"create",
			"--pull",
			"never",
			"--name",
			db.name,
			"--label",
			`${OWNER}=${nonce}`,
			"--network",
			"none",
			"--tmpfs",
			"/var/lib/postgresql/data:rw,nosuid,nodev",
			"--env",
			`POSTGRES_USER=${identity}`,
			"--env",
			`POSTGRES_DB=${identity}`,
			"--env",
			`POSTGRES_PASSWORD=${password}`,
			"--env",
			"PGDATA=/var/lib/postgresql/data/pgdata",
			postgres.Id,
			"postgres",
			"-c",
			"listen_addresses=127.0.0.1",
			"-p",
			String(port),
		], "Create isolated PostgreSQL container");
		if (!/^[a-f0-9]{64}$/.test(dbId.stdout)) throw new Error("Invalid PostgreSQL container ID");
		db.id = dbId.stdout;
		await inspect(db);
		let applicationEnv: Record<string, string> = {
			CHOPIN_RUN_NONCE: nonce,
			DATABASE_URL: url,
			SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
			CHOPIN_SOURCE_COMMIT: commit,
		};
		let environment: string[] = [];
		// Docker otherwise preserves arbitrary ENV entries embedded in the runtime image.
		for (let entry of image.Config.Env || []) {
			let key = entry.split("=", 1)[0];
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid image environment");
			environment.push("--env", `${key}=`);
		}
		for (let [key, value] of Object.entries(applicationEnv)) {
			environment.push("--env", `${key}=${value}`);
		}
		let appId = await command([
			"docker",
			"create",
			"--pull",
			"never",
			"--name",
			app.name,
			"--label",
			`${OWNER}=${nonce}`,
			"--network",
			`container:${db.id}`,
			"--mount",
			`type=bind,src=${reports},dst=/reports`,
			"--workdir",
			"/work",
			"--entrypoint",
			"/usr/local/bin/bun",
			...environment,
			image.Id,
			"scripts/conversation-plan-worker.ts",
		], "Create sealed worker container");
		if (!/^[a-f0-9]{64}$/.test(appId.stdout)) throw new Error("Invalid worker container ID");
		app.id = appId.stdout;
		await inspect(app);
		let stampFile = join(reports, "build-stamp.json");
		await command([
			"docker",
			"cp",
			`${app.id}:/work/e2e/.conversation-plan-build.json`,
			stampFile,
		], "Read runtime build stamp");
		let stamp = JSON.parse(await readFile(stampFile, "utf8"));
		await rm(stampFile);
		if (
			stamp.commit !== commit || Object.keys(stamp).sort().join(",")
				!== "buildSha256,commit,lockSha256,sourceSha256"
			|| ![stamp.lockSha256, stamp.sourceSha256, stamp.buildSha256]
				.every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
		) {
			throw new Error("Runtime build stamp mismatch");
		}
		let lockSha256 = createHash("sha256").update(await readFile(join(root, "bun.lock"))).digest(
			"hex",
		);
		let sourceSha256 = await sourceHash(root);
		if (stamp.lockSha256 !== lockSha256 || stamp.sourceSha256 !== sourceSha256) {
			throw new Error("Image source does not match checkout");
		}
		phases.push("stopped-worker-source-and-build-stamp-validated");
		await command(["docker", "start", db.id], "Start owned PostgreSQL container");
		await command(["docker", "start", app.id], "Start owned worker container");
		phases.push("owned-containers-started");
		let result = await command(["docker", "wait", app.id], "Wait for worker", LIMIT_MS);
		if (!/^\d+$/.test(result.stdout)) throw new Error("Invalid worker exit status");
		exit = Number(result.stdout);
		phases.push("worker-exited");
	} catch (error) {
		failure = error instanceof SyntaxError
			? "Invalid Docker metadata or build stamp"
			: error instanceof Error
			? error.message
			: "Supervisor failed";
	} finally {
		cleaning = true;
		for (let container of [app, db]) {
			let result = await dispose(container, command, inspect, uncertainCreations);
			cleanup.push(result);
			if (!result.absent) exit = 1;
		}
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (interrupted) exit = 1;
		await writeFile(
			join(reports, "supervisor.json"),
			JSON.stringify(
				{
					nonce,
					phases,
					exit,
					failure,
					cleanup,
					uncertainCreations: [...uncertainCreations],
					containers: { app: app.id, db: db.id },
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
		console.log(`Conversation-plan report: ${reports}`);
		process.exitCode = exit;
	}
}

if (import.meta.main) {
	await main().catch(() => {
		console.error(
			"Conversation-plan supervisor could not initialize; check required image flags and report parent",
		);
		process.exitCode = 1;
	});
}
