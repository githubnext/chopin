/**
 * A build carries on through a Chopin restart: the paired connector registers its machine again,
 * its heartbeat resumes the build and the agent's run credential still reports, so it ends Built.
 * Restarting needs a server of its own, so this file starts one against a database of its own.
 */
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { createChannel, registerTestDatabase, seedChannel, testChannelPath } from "./database";
import { authenticate, expect, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Graph } from "../apps/server/src/tasks/graphs";

const PORT = 8795;
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = "chopin_build_restart";

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

async function freshDatabase(): Promise<string> {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	return own;
}

const ENV = {
	SERVER_HOST: HOST,
	PORT: String(PORT),
	APP_ORIGIN: ORIGIN,
	STORAGE_DRIVER: "postgres",
	JEV_API_KEY: "e2e-jev-only",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
	AGENT: "off",
	BACKGROUND_JOBS: "off",
	WEB_RESEARCH: "off",
	CONVERSATION_PLAN: "off",
	DEV_QUESTIONS: "",
	DEV_COMMENTS: "",
};

let processes: ReturnType<typeof spawn>[] = [];
let directories: string[] = [];

// One disposable database and application port for the file.
test.describe.configure({ mode: "default" });

async function stop(child: ReturnType<typeof spawn>) {
	processes = processes.filter(value => value !== child);
	if (child.exitCode !== null || child.pid === undefined) return;
	let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
	process.kill(-child.pid, "SIGTERM");
	await exit;
}

/** Start Chopin on the file's database; what it logs is kept. */
async function server(database: string) {
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = { text: "" };
	let read = (chunk: Buffer) => {
		log.text = (log.text + String(chunk)).slice(-20_000);
	};
	child.stdout?.on("data", read);
	child.stderr?.on("data", read);
	processes.push(child);
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			throw new Error(`server exited with ${child.exitCode}: ${log.text.slice(-800)}`);
		}
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) return { child, log };
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("server did not become ready");
}

async function migrated(database: string) {
	let migration = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migration.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migration.stderr).text()).slice(-800)}`,
		);
	}
}

function graph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "connect",
					title: "Connect the local agent",
					context: "An isolated tracer.",
					goal: "Report through MCP across a restart.",
					acceptance: ["The agent can read the graph.", "Its reports reach Chopin."],
					dependsOn: [],
				}, {
					id: "review",
					title: "Review the connection",
					context: "Wait for the connection.",
					goal: "Verify progress survives the restart.",
					acceptance: ["The progress persists.", "The dependency is visible."],
					dependsOn: ["connect"],
				}],
			},
		}],
	};
}

/** `chopin connect` of a fixture checkout, its agent the fake implementer. */
async function connector(env: Record<string, string>) {
	let root = await mkdtemp(join(tmpdir(), "chopin-restart-checkout-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-restart-state-"));
	directories.push(root, state);
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "committed source");
	git("add", ".");
	git("commit", "-m", "fixture");
	let child = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		root,
		"--",
		"bun",
		join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
		"--complete",
		"--http",
	], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, CHOPIN_URL: ORIGIN, CHOPIN_CONNECTOR_STATE_DIR: state, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	processes.push(child);
	let output = "";
	let pairing = new Promise<string>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(`Pairing timed out: ${output}`)), 15_000);
		let read = (chunk: Buffer) => {
			output += String(chunk);
			let match = output.match(/http:\/\/[^\s]+\/machines\?pairing=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.once("exit", code => {
			clearTimeout(timer);
			reject(new Error(`Connector exited ${code}: ${output}`));
		});
	});
	return { pairing, output: () => output };
}

async function exists(path: string) {
	return access(path).then(() => true, () => false);
}

test.afterEach(async () => {
	for (let child of [...processes].toReversed()) await stop(child);
	for (let directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a build running across a Chopin restart finishes Built", async ({ page }) => {
	test.setTimeout(150_000);
	let database = await freshDatabase();
	await migrated(database);
	let chopin = await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Restart tracer\n\nBuild through a deploy.\n", {
		graph: graph(),
	});

	let signals = await mkdtemp(join(tmpdir(), "chopin-restart-signals-"));
	directories.push(signals);
	let paused = join(signals, "paused");
	let resume = join(signals, "resume");
	let local = await connector({ CHOPIN_TEST_PAUSED: paused, CHOPIN_TEST_RESUME: resume });

	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(await local.pairing);
	await page.getByRole("button", { name: "Add machine", exact: true }).click();
	await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveText("Connected");
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await page.getByRole("button", { name: "Build plan", exact: true }).click();

	// The agent has started its first task when Chopin is deployed again.
	await expect.poll(() => exists(paused), { timeout: 30_000 }).toBe(true);
	let snapshot =
		async () => (await (await page.request.get(`${ORIGIN}/api/channels/${room}/implementation`))
			.json());
	expect((await snapshot()).build.state).toBe("running");
	await stop(chopin.child);
	// Longer than a heartbeat apart, so the connector sees Chopin gone.
	await new Promise(resolve => setTimeout(resolve, 12_000));
	chopin = await server(database);
	// The agent goes on at once; its calls are retried until its machine is back.
	await writeFile(resume, "");

	await expect.poll(async () => (await snapshot()).build?.state, { timeout: 90_000 })
		.toMatch(/^(stopped|failed)$/);
	let built = await snapshot();
	expect(built.build.state, `${local.output()}\n${chopin.log.text}`).toBe("stopped");
	expect(built.build.error).toBeUndefined();
	expect(chopin.log.text).toContain("after Chopin restarted");
	expect(local.output()).not.toContain("ended this run");

	await page.reload();
	await expect(page.getByRole("button", { name: /^Built/ })).toBeVisible();
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Build/ }).click();
	let view = page.getByRole("region", { name: "Build", exact: true });
	await expect(view.getByText("Built", { exact: true })).toBeVisible();
	await expect(view.getByText("2 pull requests", { exact: true })).toBeVisible();
});
