import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
