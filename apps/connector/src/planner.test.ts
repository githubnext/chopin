import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineFile } from "./machine";
import { createOutput } from "./output";
import { commandWords, servePlanners, stopBackend } from "./planner";
import type { ServiceHost } from "./service";
import { collectStatus, formatStatus } from "./status";
import { git, lockWorkspace, startFailures } from "./workspace";

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
	["CHOPIN_URL", "CHOPIN_DOCUMENT", "CHOPIN_PLANNER_TOKEN", "SOME_FLAG"].map(name => [name, process.env[name]]),
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
			"--env",
			"SOME_FLAG=1",
			"--",
			process.execPath,
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
				{
					CHOPIN_URL: origin,
					CHOPIN_DOCUMENT: document,
					CHOPIN_PLANNER_TOKEN: issued[0],
					SOME_FLAG: "1",
				},
				{
					CHOPIN_URL: origin,
					CHOPIN_DOCUMENT: document,
					CHOPIN_PLANNER_TOKEN: issued[1],
					SOME_FLAG: "1",
				},
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
			process.execPath,
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

/** A backend whose first launch can't find its interpreter, as `#!/usr/bin/env node` can't. */
const FAILING_BACKEND = `
import { appendFileSync, readFileSync } from "node:fs";
let log = process.argv[2];
let launches = 0;
try { launches = readFileSync(log, "utf8").split("\\n").filter(Boolean).length; } catch {}
appendFileSync(log, process.pid + "\\n");
if (launches === 0) {
	process.stderr.write("\\n/usr/bin/env: 'node': No such file or directory (ghp_${
	"A".repeat(20)
})\\nmore\\n");
	process.exit(127);
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

test.skipIf(process.platform === "win32")(
	"chopin status shows a Planner backend that exits early until one stays up",
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
		let directory = await mkdtemp(join(scratch, "failing-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.log");
		await writeFile(script, FAILING_BACKEND);
		let release = await lockWorkspace(directory, directory, { planners: ["D_1"] });
		let host: ServiceHost = {
			platform: "linux",
			home: directory,
			user: "ada",
			uid: 501,
			env: {},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
		};
		let status = () =>
			collectStatus({ directory, server: "https://chopin.example", source: "config", host });
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
			failures: startFailures(directory, directory),
			healthyMs: 1000,
		});
		try {
			await until(async () => !!(await status()).connectors[0]?.failures, 10_000);
			let report = await status();
			let [failure] = report.connectors[0]!.failures!;
			expect(failure).toEqual({
				kind: "planner",
				document: "D_1",
				how: "exit 127",
				stderr: "/usr/bin/env: 'node': No such file or directory ([redacted])",
				at: expect.any(String),
				retryAt: expect.any(String),
			});
			expect(formatStatus(report, Date.parse(failure!.retryAt!) - 22_000)).toContain(
				"              Planner for D_1: failing (exit 127: /usr/bin/env: 'node': No such file or "
					+ "directory ([redacted])), retrying in 22s",
			);
			// The next launch stays up, so the failure goes.
			await until(async () => !(await status()).connectors[0]?.failures, 10_000);
			expect(formatStatus(await status())).toContain("              Planner for D_1");
		} finally {
			abort.abort();
			await serving;
			await release();
			await chopin.stop(true);
		}
	},
	30_000,
);

test.skipIf(process.platform === "win32")(
	"a Planner backend that prints its credential and an --env value leaves neither in the failures file, chopin status or chopin's own output",
	async () => {
		let token = `chopin_p_${"P".repeat(43)}`;
		let secret = "review-opaque-api-secret";
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({ token, expiresAt: Date.now() + 15 * 60_000, document: { id: "D_1" } }),
		});
		let directory = await mkdtemp(join(scratch, "leaking-"));
		let script = join(directory, "backend.ts");
		await writeFile(
			script,
			"process.stderr.write(`CHOPIN_PLANNER_TOKEN=${process.env.CHOPIN_PLANNER_TOKEN} "
				+ "OPAQUE_API_KEY=${process.env.OPAQUE_API_KEY}\\n`);\nprocess.exit(127);\n",
		);
		let release = await lockWorkspace(directory, directory, { planners: ["D_1"] });
		let host: ServiceHost = {
			platform: "linux",
			home: directory,
			user: "ada",
			uid: 501,
			env: {},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
		};
		let status = () =>
			collectStatus({ directory, server: "https://chopin.example", source: "config", host });
		// Everything chopin writes: its own lines, and the backend's stderr it passes on.
		let written = "";
		let capture = {
			write: (chunk: string | Uint8Array) => {
				written += String(chunk);
				return true;
			},
		};
		let stderr = process.stderr.write;
		process.stderr.write = capture.write as typeof process.stderr.write;
		let abort = new AbortController();
		let serving = servePlanners({
			url: `http://127.0.0.1:${chopin.port}`,
			machine: MACHINE,
			documents: ["D_1"],
			command: [process.execPath, script],
			cwd: directory,
			output: createOutput(capture, capture, {}),
			signal: abort.signal,
			failures: startFailures(directory, directory),
			env: { OPAQUE_API_KEY: secret },
		});
		try {
			await until(async () => !!(await status()).connectors[0]?.failures, 10_000);
			abort.abort();
			await serving;
			let report = await status();
			expect(report.connectors[0]!.failures![0]!.stderr).toBe(
				"CHOPIN_PLANNER_TOKEN=[redacted] OPAQUE_API_KEY=[redacted]",
			);
			let failures = await readFile(
				join(
					directory,
					`${new Bun.CryptoHasher("sha256").update(directory).digest("hex")}.failures.json`,
				),
				"utf8",
			);
			let shown = {
				failures,
				status: formatStatus(report).join("\n"),
				json: JSON.stringify(report, null, 2),
				written,
			};
			for (let [where, text] of Object.entries(shown)) {
				expect({ where, token: text.includes(token), secret: text.includes(secret) })
					.toEqual({ where, token: false, secret: false });
			}
			expect(written).toContain("Planner for D_1 exited (exit 127)");
		} finally {
			process.stderr.write = stderr;
			abort.abort();
			await serving;
			await release();
			await chopin.stop(true);
		}
	},
	30_000,
);

test.skipIf(process.platform === "win32")(
	"a Planner stderr line too long to mask is dropped whole, so a credential split across it leaks nowhere",
	async () => {
		let token = `chopin_p_${"Kq4Zt9Wm".repeat(6).slice(0, 43)}`;
		let marker = "[chopin: dropped a stderr line longer than 65536 characters]";
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({ token, expiresAt: Date.now() + 15 * 60_000, document: { id: "D_1" } }),
		});
		let directory = await mkdtemp(join(scratch, "long-line-"));
		let script = join(directory, "backend.ts");
		// The first 8 characters of the credential end a 65,545-character piece without a newline;
		// the rest comes after a pause, then a normal line.
		await writeFile(
			script,
			[
				"let token = process.env.CHOPIN_PLANNER_TOKEN;",
				"process.stderr.write(`${'x'.repeat(65536)} ${token.slice(0, 8)}`, () => setTimeout(() => {",
				"\tprocess.stderr.write(`${token.slice(8)}\\nnext CHOPIN_PLANNER_TOKEN=${token}\\n`,",
				"\t\t() => process.exit(127));",
				"}, 300));",
				"",
			].join("\n"),
		);
		let release = await lockWorkspace(directory, directory, { planners: ["D_1"] });
		let host: ServiceHost = {
			platform: "linux",
			home: directory,
			user: "ada",
			uid: 501,
			env: {},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
		};
		let status = () =>
			collectStatus({ directory, server: "https://chopin.example", source: "config", host });
		let written = "";
		let capture = {
			write: (chunk: string | Uint8Array) => {
				written += String(chunk);
				return true;
			},
		};
		let stderr = process.stderr.write;
		process.stderr.write = capture.write as typeof process.stderr.write;
		let abort = new AbortController();
		let serving = servePlanners({
			url: `http://127.0.0.1:${chopin.port}`,
			machine: MACHINE,
			documents: ["D_1"],
			command: [process.execPath, script],
			cwd: directory,
			output: createOutput(capture, capture, {}),
			signal: abort.signal,
			failures: startFailures(directory, directory),
		});
		try {
			await until(async () => !!(await status()).connectors[0]?.failures, 10_000);
			abort.abort();
			await serving;
			let report = await status();
			let failures = await readFile(
				join(
					directory,
					`${new Bun.CryptoHasher("sha256").update(directory).digest("hex")}.failures.json`,
				),
				"utf8",
			);
			let pieces = Array.from({ length: token.length - 7 }, (_, at) => token.slice(at, at + 8));
			let shown = { failures, status: formatStatus(report).join("\n"), written };
			for (let [where, text] of Object.entries(shown)) {
				expect({ where, leaked: pieces.filter(piece => text.includes(piece)) })
					.toEqual({ where, leaked: [] });
			}
			expect(written.split(marker).length - 1).toBe(1);
			expect(written).toContain(`${marker}\nnext CHOPIN_PLANNER_TOKEN=[redacted]\n`);
			expect(report.connectors[0]!.failures![0]!.stderr).toBe(marker);
		} finally {
			process.stderr.write = stderr;
			abort.abort();
			await serving;
			await release();
			await chopin.stop(true);
		}
	},
	30_000,
);

test.skipIf(process.platform === "win32")(
	"chopin status shows a Planner stopped for good, not retrying, once Chopin refuses its credential",
	async () => {
		let asked = 0;
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				asked++
					? Response.json({}, { status: 404 })
					: Response.json({ token: `chopin_p_${"P".repeat(43)}`, expiresAt: Date.now() + 60_000 }),
		});
		let directory = await mkdtemp(join(scratch, "refused-"));
		let script = join(directory, "backend.ts");
		await writeFile(script, "process.stderr.write('node: not found\\n');\nprocess.exit(127);\n");
		let release = await lockWorkspace(directory, directory, { planners: ["D_1"] });
		let host: ServiceHost = {
			platform: "linux",
			home: directory,
			user: "ada",
			uid: 501,
			env: {},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
		};
		let quiet = { write: () => true };
		try {
			// The backend exits 127, then Chopin refuses the next credential, which ends the Planner.
			await servePlanners({
				url: `http://127.0.0.1:${chopin.port}`,
				machine: MACHINE,
				documents: ["D_1"],
				command: [process.execPath, script],
				cwd: directory,
				output: createOutput(quiet, quiet, {}),
				signal: new AbortController().signal,
				failures: startFailures(directory, directory),
			});
			let report = await collectStatus({
				directory,
				server: "https://chopin.example",
				source: "config",
				host,
			});
			expect(report.connectors[0]!.failures).toEqual([{
				kind: "planner",
				document: "D_1",
				how: "Chopin refused the request (http-404).",
				stopped: true,
				at: expect.any(String),
			}]);
			expect(formatStatus(report, Date.now() + 60_000)).toContain(
				"              Planner for D_1: stopped: Chopin refused the request (http-404).",
			);
		} finally {
			await release();
			await chopin.stop(true);
		}
	},
	30_000,
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

test.skipIf(process.platform === "win32")(
	"connect --planner-command alone runs the Planners Chopin asks for, and stops one it no longer asks for",
	async () => {
		let { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
		let { WebStandardStreamableHTTPServerTransport } = await import(
			"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
		);
		let { CallToolRequestSchema, ListToolsRequestSchema } = await import(
			"@modelcontextprotocol/sdk/types.js"
		);
		let registered: Record<string, string | null>[] = [];
		let asked: unknown[] = [];
		/** Each Planner poll's `planners`, in order. */
		let polls: string[][] = [];
		let release = Promise.withResolvers<void>();
		let document = "";
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
					registered.push({
						protocol: request.headers.get("chopin-connector-protocol"),
						planner: request.headers.get("chopin-connector-planner"),
						plannerCommand: request.headers.get("chopin-connector-planner-command"),
					});
					return Response.json({ token: "connection-token" });
				}
				if (path === "/api/connector/planner") {
					asked.push(await request.json());
					return Response.json({
						token: `chopin_p_${String(asked.length).padStart(43, "P")}`,
						expiresAt: Date.now() + 15 * 60_000,
						document: { id: "D_1", url: document },
					});
				}
				if (path !== "/connector/mcp") return new Response(null, { status: 404 });
				let mcp = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
				mcp.setRequestHandler(CallToolRequestSchema, async call => {
					let args = (call.params.arguments ?? {}) as { planners?: string[] };
					let value: unknown = {};
					if (call.params.name === "wait_for_work" && args.planners) {
						polls.push(args.planners);
						if (polls.length === 1) {
							value = { kind: "planners", planners: [{ id: "D_1", url: document }] };
						} else if (polls.length === 2) {
							// Its owner chooses another machine for the document.
							await release.promise;
							value = { kind: "planners", planners: [] };
						} else await new Promise(() => {});
					} else if (call.params.name === "wait_for_work") {
						// No work for this checkout; the work poll waits.
						await new Promise(() => {});
					}
					return { content: [{ type: "text", text: JSON.stringify(value) }] };
				});
				let transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await mcp.connect(transport);
				return transport.handleRequest(request);
			},
		});
		let origin = `http://127.0.0.1:${chopin.port}`;
		document = `${origin}/octo-org/score/plan`;
		let directory = await mkdtemp(join(scratch, "dispatched-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.jsonl");
		await writeFile(script, STAYING_BACKEND);
		let root = await checkout();
		let connector = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"connect",
			root,
			"--planner-command",
			`${process.execPath} ${script} ${log}`,
			"--",
			process.execPath,
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
			await until(async () => (await entries(log)).length >= 1, 15_000);
			// It said it can run Planners, without running any of its own.
			expect(registered[0]).toEqual({ protocol: "4", planner: null, plannerCommand: "1" });
			expect(asked).toEqual([{ document }]);
			let [launched] = await entries(log);
			await until(async () => polls.length >= 2, 5_000);
			expect(polls.slice(0, 2)).toEqual([[], ["D_1"]]);

			release.resolve();
			await until(async () => (await entries(log)).some(entry => entry.stopped), 10_000);
			expect((await entries(log)).filter(entry => entry.stopped)).toEqual([{
				stopped: launched.pid,
			}]);
			await until(async () => polls.length >= 3, 5_000);
			expect(polls[2]).toEqual([]);
			// Not started again once Chopin stopped asking.
			await Bun.sleep(1_500);
			expect((await entries(log)).filter(entry => entry.pid)).toHaveLength(1);

			connector.kill("SIGINT");
			expect(await Promise.race([connector.exited, Bun.sleep(10_000).then(() => "timed out")]))
				.toBe(0);
			let [stdout, stderr] = await output;
			expect(`${stdout}${stderr}`).not.toContain("chopin_p_");
			// Its own output says why the Planner stopped, once.
			expect(stdout.split(`Stopped the Planner for ${document}`)).toHaveLength(2);
			expect(stdout).toContain(
				`Stopped the Planner for ${document}: the document chose another machine.`,
			);
		} finally {
			connector.kill("SIGKILL");
			await chopin.stop(true);
		}
	},
	40_000,
);

/**
 * A Planner backend that prints its credential and an --env value on stdout, the credential once
 * split across a line too long to mask, then exits as a failing backend does.
 */
const STDOUT_LEAKING_BACKEND = `
import { appendFileSync } from "node:fs";
let token = process.env.CHOPIN_PLANNER_TOKEN;
appendFileSync(process.argv[2], JSON.stringify({ document: process.env.CHOPIN_DOCUMENT, token }) + "\\n");
process.stdout.write(\`\${"x".repeat(65536)} \${token.slice(0, 8)}\`, () => setTimeout(() => {
	process.stdout.write(
		\`\${token.slice(8)}\\nCHOPIN_PLANNER_TOKEN=\${token} OPAQUE_API_KEY=\${process.env.OPAQUE_API_KEY}\\n\`,
		() => process.exit(127),
	);
}, 300));
`;

test.skipIf(process.platform === "win32")(
	"a Planner backend's stdout reaches chopin's output masked, for --planner and dispatched backends alike",
	async () => {
		let { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
		let { WebStandardStreamableHTTPServerTransport } = await import(
			"@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
		);
		let { CallToolRequestSchema, ListToolsRequestSchema } = await import(
			"@modelcontextprotocol/sdk/types.js"
		);
		let secret = "review-opaque-api-secret";
		let issued: string[] = [];
		let own = "";
		let assigned = "";
		let polls = 0;
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
					let { document } = await request.json() as { document: string };
					let token = `chopin_p_${
						Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
					}`;
					issued.push(token);
					return Response.json({
						token,
						expiresAt: Date.now() + 15 * 60_000,
						document: document === own ? { id: "D_1", url: own } : { id: "D_2", url: assigned },
					});
				}
				if (path !== "/connector/mcp") return new Response(null, { status: 404 });
				let mcp = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
				mcp.setRequestHandler(CallToolRequestSchema, async call => {
					let args = (call.params.arguments ?? {}) as { planners?: string[] };
					let value: unknown = {};
					// Chopin asks this machine to run the second document's Planner, then waits.
					if (call.params.name === "wait_for_work" && args.planners && polls++ === 0) {
						value = { kind: "planners", planners: [{ id: "D_2", url: assigned }] };
					} else if (call.params.name === "wait_for_work") await new Promise(() => {});
					return { content: [{ type: "text", text: JSON.stringify(value) }] };
				});
				let transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await mcp.connect(transport);
				return transport.handleRequest(request);
			},
		});
		let origin = `http://127.0.0.1:${chopin.port}`;
		own = `${origin}/octo-org/score/plan`;
		assigned = `${origin}/octo-org/score/other`;
		let directory = await mkdtemp(join(scratch, "stdout-"));
		let script = join(directory, "backend.ts");
		let log = join(directory, "launches.jsonl");
		await writeFile(script, STDOUT_LEAKING_BACKEND);
		let root = await checkout();
		let state = await mkdtemp(join(scratch, "state-"));
		let connector = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "main.ts"),
			"connect",
			root,
			"--planner",
			own,
			"--planner-command",
			`${process.execPath} ${script} ${log}`,
			"--env",
			`OPAQUE_API_KEY=${secret}`,
			"--",
			process.execPath,
		], {
			env: { ...process.env, CHOPIN_URL: origin, CHOPIN_CONNECTOR_STATE_DIR: state },
			stdout: "pipe",
			stderr: "pipe",
		});
		let output = Promise.all([
			new Response(connector.stdout).text(),
			new Response(connector.stderr).text(),
		]);
		let host: ServiceHost = {
			platform: "linux",
			home: directory,
			user: "ada",
			uid: 501,
			env: {},
			run: async () => ({ code: 1, stdout: "", stderr: "" }),
		};
		let status = () =>
			collectStatus({ directory: state, server: "https://chopin.example", source: "config", host });
		try {
			// Both backends, the --planner one and the dispatched one, ran and failed.
			await until(async () => {
				let documents = new Set((await entries(log)).map(entry => entry.document));
				return documents.has(own) && documents.has(assigned)
					&& (await status()).connectors[0]?.failures?.length === 2;
			}, 20_000);
			let report = await status();
			// Read while it runs: a connector that stops clears its failures.
			let failures = await Promise.all(
				(await readdir(state)).filter(name => name.endsWith(".failures.json"))
					.map(name => readFile(join(state, name), "utf8")),
			);
			expect(failures).toHaveLength(1);
			connector.kill("SIGINT");
			expect(await Promise.race([connector.exited, Bun.sleep(10_000).then(() => "timed out")]))
				.toBe(0);
			let [stdout, stderr] = await output;
			let shown = {
				stdout,
				stderr,
				failures: failures.join("\n"),
				status: formatStatus(report).join("\n"),
				json: JSON.stringify(report),
			};
			let pieces = issued.flatMap(token =>
				Array.from({ length: token.length - 7 }, (_, at) => token.slice(at, at + 8))
					.filter(piece => !"chopin_p_".includes(piece))
			);
			for (let [where, text] of Object.entries(shown)) {
				// status --json reports the saved connect settings, --env values among them.
				let secrets = where === "json" ? pieces : [...pieces, secret];
				expect({ where, leaked: secrets.filter(piece => text.includes(piece)) })
					.toEqual({ where, leaked: [] });
			}
			// What the backends printed still reaches chopin's output, masked.
			expect(stdout).toContain("CHOPIN_PLANNER_TOKEN=[redacted] OPAQUE_API_KEY=[redacted]");
			expect(stdout).toContain("[chopin: dropped a stdout line longer than 65536 characters]");
		} finally {
			connector.kill("SIGKILL");
			await chopin.stop(true);
		}
	},
	40_000,
);
