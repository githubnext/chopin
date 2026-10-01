import { SQL } from "bun";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { cp, lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { networkInterfaces } from "node:os";

const ROOT = "/work";
const TITLE = "(?:^| )read-only collaborators cannot retry a failed Planner job$";
const OMIT = new Set(["node_modules", "dist", "test-results", ".conversation-plan-build.json"]);

export function sourcePath(path: string): boolean {
	let reserved =
		/^(?:node_modules|dist|test-results|playwright-report|\.conversation-plan-build\.json|\.codex|\.agents|\.claude|\.opencode|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\.json)?|secrets(?:\.json)?|data|artifacts|evals?|evaluations?|corpus|datasets?|\.scratch)$/;
	return !path.split("/").some(name =>
		reserved.test(name)
		|| /^(?:\.env|\.git|id_rsa|id_ed25519)/.test(name)
		|| /\.(?:pem|key|p12|pfx|log|tsbuildinfo)$/.test(name)
	)
		&& path !== "e2e/design/snapshots" && !path.startsWith("e2e/design/snapshots/");
}

export function sourceHash(root: string): Promise<string> {
	return treeHash(
		root,
		[
			"apps/server",
			"apps/web",
			"packages",
			"e2e",
			"patches",
			"scripts/conversation-plan.ts",
			"scripts/conversation-plan-worker.ts",
			"package.json",
			"bun.lock",
			"tsconfig.json",
		],
		OMIT,
		sourcePath,
	);
}

export async function treeHash(
	root: string,
	paths: string[],
	omit = OMIT,
	include = (_path: string) => true,
): Promise<string> {
	let files: string[] = [];
	async function visit(path: string): Promise<void> {
		if (!include(path)) return;
		let entry = await lstat(join(root, path));
		if (entry.isFile()) files.push(path);
		else if (entry.isDirectory()) {
			for (let name of await readdir(join(root, path))) {
				if (!omit.has(name)) await visit(`${path}/${name}`);
			}
		} else throw new Error("hash tree contains a nonregular entry");
	}
	for (let path of paths) await visit(path);
	let hash = createHash("sha256");
	for (let path of files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
		let digest = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
		hash.update(`${path}\0${digest}\n`);
	}
	return hash.digest("hex");
}

export function inputs(env: Record<string, string | undefined>) {
	let nonce = env.CHOPIN_RUN_NONCE ?? "";
	let key = env.SESSION_SIGNING_KEY ?? "";
	let commit = env.CHOPIN_SOURCE_COMMIT ?? "";
	if (
		!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(key)
		|| !/^[a-f0-9]{40}$/.test(commit)
	) throw new Error("invalid ownership inputs");
	let database = new URL(env.DATABASE_URL ?? "");
	let port = Number(database.port);
	if (
		database.protocol !== "postgres:" || database.hostname !== "127.0.0.1"
		|| port < 20000 || port > 60999 || database.username !== `cp_${nonce}`
		|| database.pathname !== `/cp_${nonce}` || !/^[a-f0-9]{64}$/.test(database.password)
		|| database.search !== "?sslmode=disable" || database.hash
	) {
		throw new Error("database does not match generated ownership");
	}
	return { nonce, key, commit, database: database.href };
}

async function stamp(commit: string): Promise<void> {
	let built = JSON.parse(await readFile(`${ROOT}/e2e/.conversation-plan-build.json`, "utf8"));
	let lockSha256 = createHash("sha256").update(await readFile(`${ROOT}/bun.lock`)).digest("hex");
	let sourceSha256 = await sourceHash(ROOT);
	let buildSha256 = await treeHash(ROOT, ["apps/web/dist"], new Set());
	if (
		built.commit !== commit || built.lockSha256 !== lockSha256
		|| built.sourceSha256 !== sourceSha256 || built.buildSha256 !== buildSha256
	) {
		throw new Error("image build stamp does not match source and client");
	}
	await readFile(`${ROOT}/apps/web/dist/index.html`);
}

export type NamespaceLink = {
	flags: string;
	operstate: string;
	type: string;
	path: string;
	index: string;
	link: string;
	addresses: { address: string; family: string; internal: boolean }[];
};

const FALLBACK_TYPES: Record<string, string> = {
	tunl0: "768",
	gre0: "778",
	gretap0: "1",
	erspan0: "1",
	ip_vti0: "768",
	ip6_vti0: "769",
	sit0: "776",
	ip6tnl0: "769",
	ip6gre0: "823",
};

export function checkNamespace(
	dev: string,
	route: string,
	ipv6Route: string,
	links: Record<string, NamespaceLink>,
): void {
	let rows = dev.trim().split("\n");
	let headers = rows.slice(0, 2).map(line =>
		line.trim().replace(/\s+/g, " ").split("|").map(part => part.trim()).join("|")
	);
	if (
		headers[0] !== "Inter-|Receive|Transmit" || headers[1]
			!== "face|bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed"
	) {
		throw new Error("invalid device headers");
	}
	let devices = rows.slice(2).map(line => {
		let parts = line.trim().split(":");
		let counters = parts[1]?.trim().split(/\s+/);
		if (
			parts.length !== 2 || !/^[A-Za-z0-9_]+$/.test(parts[0]!)
			|| counters?.length !== 16 || counters.some(value => !/^[0-9]+$/.test(value))
		) {
			throw new Error("invalid device counters");
		}
		return parts[0]!;
	});
	if (
		!devices.includes("lo") || new Set(devices).size !== devices.length
		|| !links || Object.keys(links).length !== devices.length
		|| Object.keys(links).some(name => !devices.includes(name))
	) {
		throw new Error("interface inventory mismatch");
	}
	let indices = new Set<string>();
	for (let name of devices) {
		let entry = links[name];
		if (
			!entry || [entry.flags, entry.operstate, entry.type, entry.path, entry.index, entry.link]
				.some(value => typeof value !== "string")
			|| !/^0x[0-9a-f]{1,8}$/.test(entry.flags)
			|| !/^[1-9][0-9]{0,9}$/.test(entry.index) || Number(entry.index) > 2147483647
			|| !/^(?:0|[1-9][0-9]{0,9})$/.test(entry.link) || Number(entry.link) > 2147483647
			|| !/^(?:0|[1-9][0-9]{0,4})$/.test(entry.type) || Number(entry.type) > 65535
			|| indices.has(entry.index)
			|| !Array.isArray(entry.addresses) || entry.path !== `/sys/devices/virtual/net/${name}`
		) {
			throw new Error("invalid interface evidence");
		}
		indices.add(entry.index);
		let flags = Number.parseInt(entry.flags.slice(2), 16);
		if (name === "lo") {
			if (
				(flags & 9) !== 9 || entry.type !== "772" || entry.link !== entry.index
				|| !["unknown", "up"].includes(entry.operstate) || !entry.addresses.length
				|| entry.addresses.some(address =>
					!address || address.internal !== true
					|| !((address.family === "IPv4" && address.address === "127.0.0.1")
						|| (address.family === "IPv6" && address.address === "::1"))
				)
			) {
				throw new Error("invalid loopback interface");
			}
		} else if (
			!Object.hasOwn(FALLBACK_TYPES, name) || entry.type !== FALLBACK_TYPES[name]
			|| entry.link !== "0" || flags & 1 || entry.operstate !== "down"
			|| entry.addresses.length
		) {
			throw new Error("active or unknown non-loopback interface");
		}
	}

	let routes = route.trim().split("\n");
	if (
		routes.shift()?.trim().split(/\s+/).join(" ")
			!== "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT"
	) {
		throw new Error("invalid IPv4 route header");
	}
	if (routes.length) throw new Error("IPv4 route outside empty namespace");
	let ipv6 = ipv6Route.trim().split("\n").filter(Boolean);
	for (let route of ipv6) {
		let fields = route.trim().split(/\s+/);
		let zero = "00000000000000000000000000000000";
		let local = fields[0] === `${zero.slice(0, -1)}1` && fields[1] === "80";
		let reject = fields[0] === zero && fields[1] === "00"
			&& (Number.parseInt(fields[8] ?? "", 16) & 0x200) !== 0;
		if (
			fields.length !== 10 || fields.slice(5, 9).some(value => !/^[0-9a-f]{8}$/.test(value))
			|| fields[9] !== "lo" || !(local || reject)
			|| fields[2] !== zero || fields[3] !== "00" || fields[4] !== zero
		) {
			throw new Error("non-loopback IPv6 route");
		}
	}
}

async function namespaceLinks(): Promise<Record<string, NamespaceLink>> {
	let names = await readdir("/sys/class/net");
	let addresses = networkInterfaces();
	if (Object.keys(addresses).some(name => !names.includes(name))) {
		throw new Error("address inventory mismatch");
	}
	let entries = await Promise.all(names.map(async name => {
		let path = `/sys/class/net/${name}`;
		let [flags, operstate, type, index, link, resolved] = await Promise.all([
			...["flags", "operstate", "type", "ifindex", "iflink"].map(field =>
				readFile(`${path}/${field}`, "utf8").then(value => value.trim())
			),
			realpath(path),
		]);
		let entry: NamespaceLink = {
			flags: flags!,
			operstate: operstate!,
			type: type!,
			index: index!,
			link: link!,
			path: resolved!,
			addresses: (addresses[name] ?? []).map(({ address, family, internal }) => ({
				address,
				family,
				internal,
			})),
		};
		let pair: [string, NamespaceLink] = [name, entry];
		return pair;
	}));
	return Object.fromEntries(entries);
}

async function namespace(report: Record<string, unknown>): Promise<void> {
	report.namespaceStep = "proc";
	let [dev, route, ipv6Route] = await Promise.all([
		readFile("/proc/net/dev", "utf8"),
		readFile("/proc/net/route", "utf8"),
		readFile("/proc/net/ipv6_route", "utf8"),
	]);
	report.namespaceStep = "links";
	let links = await namespaceLinks();
	report.namespaceEvidence = { links, dev, route, ipv6Route };
	report.namespaceStep = "interfaces-and-routes";
	checkNamespace(dev, route, ipv6Route, links);
	report.namespaceStep = "socket";
	await new Promise<void>((resolve, reject) => {
		let socket = connect({ host: "1.1.1.1", port: 443 });
		let timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("egress probe timed out"));
		}, 2000);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error("socket egress allowed"));
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			// Bun 1.4.2 maps kernel ENETUNREACH to ECONNREFUSED in this verified route-free namespace.
			let mapped = Bun.version === "1.4.2" && error.code === "ECONNREFUSED";
			if (mapped || ["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(error.code ?? "")) {
				report.socketDenial = mapped ? "bun-mapped-unreachable" : "routing-denial";
				resolve();
			} else reject(new Error("socket denial could not be attested"));
		});
	});
	report.namespaceStep = "fetch";
	try {
		let response = await fetch("http://1.1.1.1/", {
			redirect: "error",
			signal: AbortSignal.timeout(2000),
		});
		await response.body?.cancel();
		throw new Error("fetch egress allowed");
	} catch (error) {
		if (!(error instanceof TypeError)) {
			throw new Error("fetch denial could not be attested", { cause: error });
		}
	}
	report.namespaceStep = "complete";
}

async function freePort(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let server = createServer();
		server.once("error", () => reject(new Error(`owned namespace port ${port} is occupied`)));
		server.listen(
			{ host: "127.0.0.1", port, exclusive: true },
			() =>
				server.close(error => error ? reject(new Error("port preflight close failed")) : resolve()),
		);
	});
}

export function environment(owned: ReturnType<typeof inputs>): Record<string, string> {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: "/tmp",
		CI: "1",
		PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
		E2E_CONVERSATION_PLAN: "1",
		E2E_DATABASE_URL_0: owned.database,
		DATABASE_URL: owned.database,
		SESSION_ENCRYPTION_KEY: owned.key,
		STORAGE_DRIVER: "postgres",
		PORT: "8788",
		SERVER_HOST: "127.0.0.1",
		APP_ORIGIN: "http://127.0.0.1:8788",
		AGENT: "on",
		CONVERSATION_PLAN: "on",
		HARNESS: "e2e-prompt-scripted",
		HARNESS_AUTH: "direct",
		MODEL: "e2e-prompt-scripted-model",
		JEV_API_KEY: "e2e-jev-only",
		JEV_MODEL: "jev-e2e",
		TYPESAFE_API_KEY: "",
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		ALL_PROXY: "",
		http_proxy: "",
		https_proxy: "",
		all_proxy: "",
		NO_PROXY: "*",
		no_proxy: "*",
		E2E_PLANNER_JOBS_DIR: `${ROOT}/e2e/test-results/planner-jobs`,
		E2E_JEV_CONTROL_DIR: `${ROOT}/e2e/test-results/jev-control`,
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		GITHUB_APP_SLUG: "chopin-e2e",
		GITHUB_APP_CLIENT_ID: "e2e",
		GITHUB_APP_CLIENT_SECRET: "e2e",
		GITHUB_ALLOWED_USERS: "",
		GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
		DEV_QUESTIONS: "",
		DEV_COMMENTS: "",
	};
}

async function database(url: string): Promise<void> {
	let sql = new SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 2 });
	try {
		let ready = false;
		for (let attempt = 0; attempt < 30 && !ready; attempt++) {
			try {
				let rows = await sql`SELECT current_database() AS db, current_user AS owner,
					current_setting('server_version_num')::integer AS version`;
				let expected = new URL(url);
				if (
					rows[0]?.db !== expected.pathname.slice(1) || rows[0]?.owner !== expected.username
					|| rows[0]?.version < 170000 || rows[0]?.version >= 180000
				) {
					throw new Error("owned database identity mismatch");
				}
				ready = true;
			} catch {
				if (attempt === 29) throw new Error("owned PostgreSQL readiness failed");
			}
			if (!ready) await Bun.sleep(500);
		}
		await sql`SET statement_timeout = '5s'`;
		let tables = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'`;
		if (tables.length) throw new Error("owned database is not fresh");
		let { migrate } = await import("../apps/server/src/storage/postgres/migrations");
		await migrate(sql);
	} finally {
		await sql.close();
	}
}

async function artifacts(report: Record<string, unknown>): Promise<void> {
	let path = `${ROOT}/e2e/test-results/conversation-plan`;
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await cp(path, "/reports/playwright-results", {
		recursive: true,
		filter: async source => {
			let info = await lstat(source);
			if (!info.isFile() && !info.isDirectory()) throw new Error("nonregular test artifact");
			return true;
		},
	});
	report.artifactsCopied = true;
}

async function cleanup(pid: number, exited: Promise<number>, report: Record<string, unknown>) {
	for (let name of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pid, name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") report.signalFailed = true;
		}
		if (name === "SIGTERM") await Bun.sleep(2500);
	}
	report.cliExit = await Promise.race([exited, Bun.sleep(2500).then(() => null)]);
	try {
		process.kill(-pid, 0);
		report.groupGone = false;
	} catch (error) {
		report.groupGone = (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (report.cliExit === null || !report.groupGone || report.signalFailed) {
		throw new Error("CLI cleanup was not verified");
	}
}

async function run(report: Record<string, unknown>, env: Record<string, string>): Promise<number> {
	let log = openSync("/reports/cli.log", "wx");
	let child;
	try {
		child = Bun.spawn([
			"bun",
			"node_modules/@playwright/test/cli.js",
			"test",
			"e2e/conversation-plan-jobs.e2e.ts",
			"--config",
			"e2e/conversation-plan.playwright.config.ts",
			"--grep",
			TITLE,
		], { cwd: ROOT, env, detached: true, stdin: "ignore", stdout: log, stderr: log });
	} finally {
		closeSync(log);
	}
	let { promise: interrupted, resolve: wake } = Promise.withResolvers<void>();
	let stop = () => {
		report.interrupted = true;
		wake();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	let timer = setTimeout(() => {
		report.deadline = true;
		wake();
	}, 90_000);
	let failure = await Promise.race([child.exited, interrupted]).then(
		() => undefined,
		error => error,
	);
	clearTimeout(timer);
	let cleanupFailure = await cleanup(child.pid, child.exited, report).then(
		() => undefined,
		error => error,
	);
	report.cliSignal = child.signalCode;
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	let artifactFailure = await artifacts(report).then(() => undefined, error => error);
	if (cleanupFailure) report.cleanupFailed = true;
	if (artifactFailure) report.artifactCopyFailed = true;
	if (failure || cleanupFailure || artifactFailure) {
		throw failure ?? cleanupFailure ?? artifactFailure;
	}
	return report.interrupted || report.deadline ? 1 : Number(report.cliExit);
}

export async function main(): Promise<number> {
	let report: Record<string, unknown> = { phase: "inputs", success: false };
	let preflightDeadline = setTimeout(() => {
		report.preflightDeadline = true;
		void writeFile("/reports/worker.json", `${JSON.stringify(report, null, 2)}\n`)
			.finally(() => process.exit(124));
	}, 60_000);
	try {
		if (process.argv.length !== 2 || process.cwd() !== ROOT) {
			throw new Error("fixed worker invocation required");
		}
		let owned = inputs(process.env);
		report.nonce = owned.nonce;
		report.commit = owned.commit;
		report.phase = "stamp";
		await stamp(owned.commit);
		report.phase = "namespace";
		await namespace(report);
		report.egressDenied = true;
		report.phase = "ports";
		await freePort(8788);
		await freePort(8797);
		report.phase = "database";
		await database(owned.database);
		report.migrated = true;
		clearTimeout(preflightDeadline);
		report.phase = "test";
		let exit = await run(report, environment(owned));
		report.phase = "cleanup";
		await freePort(8788);
		await freePort(8797);
		report.listenersGone = true;
		report.success = exit === 0;
		report.phase = "complete";
		return exit;
	} catch {
		report.failed = true;
		return 1;
	} finally {
		clearTimeout(preflightDeadline);
		await writeFile("/reports/worker.json", `${JSON.stringify(report, null, 2)}\n`);
	}
}

if (import.meta.main) process.exitCode = await main();
