import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineFile } from "./machine";
import { createOutput } from "./output";
import { commandWords, servePlanners, stopBackend } from "./planner";
import { git } from "./workspace";

let scratch = await mkdtemp(join(tmpdir(), "chopin-planner-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const MACHINE = `chopin_m_${"M".repeat(43)}`;

async function checkout() {
	let root = await mkdtemp(join(scratch, "checkout-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	return root;
}

/**
 * A Planner backend command that records how each launch was started: the first launch exits at
 * once, as a backend whose link closed does, and the next one runs until it is told to stop.
 */
const BACKEND = `
import { appendFileSync, readFileSync } from "node:fs";
let log = process.argv[2];
let launches = 0;
try { launches = readFileSync(log, "utf8").split("\\n").filter(line => line.includes('"argv"')).length; } catch {}
let env = Object.fromEntries(
	["CHOPIN_URL", "CHOPIN_DOCUMENT", "CHOPIN_PLANNER_TOKEN"].map(name => [name, process.env[name]]),
);
appendFileSync(log, JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv, env }) + "\\n");
if (launches === 0) process.exit(3);
process.on("SIGTERM", () => {
	appendFileSync(log, JSON.stringify({ stopped: process.pid }) + "\\n");
	process.exit(0);
});
setInterval(() => {}, 1000);
`;

async function entries(log: string) {
	let text = await readFile(log, "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function until(condition: () => Promise<boolean>, withinMs: number) {
	for (let deadline = Date.now() + withinMs; Date.now() < deadline; await Bun.sleep(50)) {
		if (await condition()) return;
	}
	throw new Error("timed out");
}

test(
	"connect --planner starts the backend with a fresh credential in its environment, restarts it and stops it on Ctrl-C",
	async () => {
		let issued: string[] = [];
		let asked: Array<{ authorization: string | null; body: unknown }> = [];
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				let path = new URL(request.url).pathname;
				if (path === "/api/connector/pairings") {
					return Response.json({ id: "pairing", secret: "secret", url: "http://x", code: "AB" });
				}
				if (path === "/api/connector/pairings/pairing/claim") {
					return Response.json({ token: MACHINE });
				}
				if (path === "/api/connector/connections") {
					return Response.json({ token: "connection-token" });
				}
				if (path === "/api/connector/planner") {
					asked.push({
						authorization: request.headers.get("authorization"),
						body: await request.json(),
					});
					let token = `chopin_p_${String(issued.length).padStart(43, "P")}`;
					issued.push(token);
					return Response.json({
						token,
						expiresAt: Date.now() + 15 * 60_000,
						document: { id: "D_1", url: `${origin}/octo-org/score/plan` },
					});
				}
				// Chopin is out of reach for the build channel; the Planner keeps going regardless.
				return new Response(null, { status: 503 });
			},
		});
		let origin: string = `http://127.0.0.1:${chopin.port}`;
		let directory = await mkdtemp(join(scratch, "backend-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.jsonl");
		await writeFile(script, BACKEND);
		let root = await checkout();
		let document = `${origin}/octo-org/score/plan`;
		let connector = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"connect",
			root,
			"--planner",
			document,
			"--planner-command",
			`${process.execPath} ${script} ${log}`,
			"--",
			"agent",
		], {
			env: {
				...process.env,
				CHOPIN_URL: origin,
				CHOPIN_CONNECTOR_STATE_DIR: await mkdtemp(join(scratch, "state-")),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		let output = Promise.all([
			new Response(connector.stdout).text(),
			new Response(connector.stderr).text(),
		]);
		try {
			await until(async () => (await entries(log)).filter(entry => entry.argv).length >= 2, 15_000);
			let launches = (await entries(log)).filter(entry => entry.argv);
			expect(launches.map(launch => launch.env)).toEqual([
				{ CHOPIN_URL: origin, CHOPIN_DOCUMENT: document, CHOPIN_PLANNER_TOKEN: issued[0] },
				{ CHOPIN_URL: origin, CHOPIN_DOCUMENT: document, CHOPIN_PLANNER_TOKEN: issued[1] },
			]);
			expect(launches.map(launch => launch.argv.slice(1))).toEqual([[script, log], [script, log]]);
			expect(asked).toEqual([
				{ authorization: `Bearer ${MACHINE}`, body: { document } },
				{ authorization: `Bearer ${MACHINE}`, body: { document } },
			]);

			connector.kill("SIGINT");
			expect(await Promise.race([connector.exited, Bun.sleep(10_000).then(() => "timed out")]))
				.toBe(0);
			let running = launches[1].pid as number;
			expect((await entries(log)).filter(entry => entry.stopped)).toEqual([{ stopped: running }]);
			expect(() => process.kill(running, 0)).toThrow();
			let [stdout, stderr] = await output;
			for (let token of issued) {
				expect(stdout).not.toContain(token);
				expect(stderr).not.toContain(token);
			}
			expect(stdout).toContain("Planner for");
		} finally {
			connector.kill("SIGKILL");
			await chopin.stop(true);
		}
	},
	30_000,
);

/** A Planner backend that records each launch and runs until it is told to stop. */
const STAYING_BACKEND = `
import { appendFileSync } from "node:fs";
let log = process.argv[2];
appendFileSync(log, JSON.stringify({ pid: process.pid, token: process.env.CHOPIN_PLANNER_TOKEN }) + "\\n");
process.on("SIGTERM", () => {
	appendFileSync(log, JSON.stringify({ stopped: process.pid }) + "\\n");
	process.exit(0);
});
setInterval(() => {}, 1000);
`;

test(
	"on a terminal, a machine paired again after its token was revoked stops the old Planner backend and starts one with a credential from its new token",
	async () => {
		const REVOKED = `chopin_m_${"R".repeat(43)}`;
		let directory = await mkdtemp(join(scratch, "repair-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.jsonl");
		await writeFile(script, STAYING_BACKEND);
		let issued: Array<{ machine: string; token: string }> = [];
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				let path = new URL(request.url).pathname;
				let bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
				if (path === "/api/connector/pairings") {
					return Response.json({ id: "pairing", secret: "secret", url: "http://x", code: "AB" });
				}
				if (path === "/api/connector/pairings/pairing/claim") {
					return Response.json({ token: MACHINE });
				}
				if (path === "/api/connector/connections") {
					if (bearer === MACHINE) return Response.json({ token: "connection-token" });
					// The machine is revoked once its Planner backend is already running.
					await until(async () => (await entries(log)).length >= 1, 15_000);
					return Response.json({ error: "machine-revoked" }, { status: 401 });
				}
				if (path === "/api/connector/planner") {
					let token = `chopin_p_${String(issued.length).padStart(43, "P")}`;
					issued.push({ machine: bearer, token });
					return Response.json({
						token,
						expiresAt: Date.now() + 15 * 60_000,
						document: { id: "D_1", url: document },
					});
				}
				// Chopin is out of reach for the build channel; the Planner keeps going regardless.
				return new Response(null, { status: 503 });
			},
		});
		let origin = `http://127.0.0.1:${chopin.port}`;
		let document = `${origin}/octo-org/score/plan`;
		let home = await mkdtemp(join(scratch, "home-"));
		await writeFile(
			machineFile(home),
			JSON.stringify({ servers: { [origin]: { token: REVOKED, label: "box" } } }),
			{ mode: 0o600 },
		);
		let root = await checkout();
		let output = "";
		let connector = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"connect",
			root,
			"--planner",
			document,
			"--planner-command",
			`${process.execPath} ${script} ${log}`,
			"--",
			"agent",
		], {
			env: {
				...process.env,
				CHOPIN_URL: origin,
				CHOPIN_HOME: home,
				CHOPIN_CONNECTOR_STATE_DIR: "",
			},
			terminal: {
				cols: 200,
				rows: 24,
				data(_terminal, data) {
					output += new TextDecoder().decode(data);
				},
			},
		});
		try {
			await until(async () => (await entries(log)).filter(entry => entry.pid).length >= 2, 20_000);
			let [first, stopped, second] = await entries(log);
			expect(output).toContain("needs pairing with Chopin again");
			expect(issued.map(credential => credential.machine)).toEqual([REVOKED, MACHINE]);
			// The old backend stopped before the new one started, which holds the new token's credential.
			expect(stopped).toEqual({ stopped: first.pid });
			expect(first.token).toBe(issued[0]!.token);
			expect(second.token).toBe(issued[1]!.token);
			expect(alive(first.pid)).toBe(false);

			connector.kill("SIGINT");
			expect(await Promise.race([connector.exited, Bun.sleep(10_000).then(() => "timed out")]))
				.toBe(0);
			expect((await entries(log)).at(-1)).toEqual({ stopped: second.pid });
		} finally {
			connector.kill("SIGKILL");
			connector.terminal?.close();
			await chopin.stop(true);
		}
	},
	40_000,
);

/**
 * A backend that forks a helper which ignores SIGTERM, as a shell wrapper or a language server
 * might. The first launch exits on its own once its helper runs; the next exits on SIGTERM.
 */
const FORKING_BACKEND = `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
let log = process.argv[2];
let launches = 0;
try { launches = readFileSync(log, "utf8").split("\\n").filter(line => line.includes('"helper"')).length; } catch {}
let helper = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise(resolve => helper.stdout.once("data", resolve));
appendFileSync(log, JSON.stringify({ backend: process.pid, helper: helper.pid }) + "\\n");
if (launches === 0) process.exit(3);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test.skipIf(process.platform === "win32")(
	"a backend's own children are killed with it, whether it exits by itself or is stopped",
	async () => {
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					token: `chopin_p_${"P".repeat(43)}`,
					expiresAt: Date.now() + 15 * 60_000,
					document: { id: "D_1", url: "http://x" },
				}),
		});
		let directory = await mkdtemp(join(scratch, "forking-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.jsonl");
		await writeFile(script, FORKING_BACKEND);
		let abort = new AbortController();
		let quiet = { write: () => true };
		let serving = servePlanners({
			url: `http://127.0.0.1:${chopin.port}`,
			machine: MACHINE,
			documents: ["D_1"],
			command: [process.execPath, script, log],
			cwd: directory,
			output: createOutput(quiet, quiet, {}),
			signal: abort.signal,
		});
		let helpers: number[] = [];
		try {
			await until(async () => (await entries(log)).length >= 2, 20_000);
			helpers = (await entries(log)).map(entry => entry.helper as number);
			// The first backend's helper went before the backend was started again.
			expect(alive(helpers[0]!)).toBe(false);
			expect(alive(helpers[1]!)).toBe(true);

			let stopping = Date.now();
			abort.abort();
			await serving;
			expect(Date.now() - stopping).toBeLessThan(5_000 + 2_000);
			await until(async () => !alive(helpers[1]!), 1_000);
		} finally {
			abort.abort();
			for (let pid of helpers) if (alive(pid)) process.kill(pid, "SIGKILL");
			await chopin.stop(true);
		}
	},
	40_000,
);

test("on Windows a stopped backend's process tree is ended with taskkill", async () => {
	let backend = { pid: 4321, kill: mock(() => true) };
	let run = mock(async (_command: string[]) => 0);
	await stopBackend(backend, { platform: "win32", run, graceMs: 5_000 });
	expect(run.mock.calls).toEqual([[["taskkill", "/T", "/F", "/PID", "4321"]]]);
	expect(backend.kill).not.toHaveBeenCalled();

	// Where taskkill cannot end it, the backend itself still is.
	await stopBackend(backend, { platform: "win32", run: async () => 1, graceMs: 5_000 });
	expect(backend.kill).toHaveBeenCalledTimes(1);
});

test("--planner-command splits into words as a shell would, quotes and escapes included", () => {
	expect(commandWords(`my-planner --label="hello world" 'a b'c --x=\\"y\\" "C:\\\\dir"`))
		.toEqual(["my-planner", "--label=hello world", "a bc", '--x="y"', "C:\\dir"]);
	expect(commandWords(`node '/path with "quotes"/run.js' one\\ word "it's"`))
		.toEqual(["node", '/path with "quotes"/run.js', "one word", "it's"]);
	expect(commandWords(`  spaced   out  `)).toEqual(["spaced", "out"]);
	expect(commandWords(`say ""`)).toEqual(["say", ""]);
	expect(() => commandWords(`my-planner --label="hello`)).toThrow(/unmatched double quote/);
	expect(() => commandWords(`my-planner 'hello`)).toThrow(/unmatched single quote/);
});
