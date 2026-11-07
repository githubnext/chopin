import { SQL } from "bun";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresStorage } from "./adapter";

import type { Subprocess } from "bun";

let database = process.env.TEST_DATABASE_URL;
let running: Subprocess[] = [];
let client = mkdtempSync(join(tmpdir(), "chopin-client-"));
writeFileSync(join(client, "index.html"), "<!doctype html><title>Chopin</title>");
mkdirSync(join(client, "assets"));
writeFileSync(join(client, "assets", "app-abcd1234.js"), "export {};");

afterAll(() => rmSync(client, { recursive: true, force: true }));
afterEach(async () => {
	for (let child of running) child.kill();
	await Promise.all(running.map(child => child.exited));
	running = [];
});

type Server = { child: Subprocess; port: number; output: () => string };

function spawn(port: number, extra: Record<string, string> = {}): Server {
	let child = Bun.spawn(["bun", join(import.meta.dir, "../../main.ts")], {
		env: {
			...process.env,
			AGENT: "off",
			JEV_API_KEY: "synthetic-test-key",
			APP_ORIGIN: `http://127.0.0.1:${port}`,
			CLIENT_DIR: client,
			DATABASE_URL: database!,
			GITHUB_APP_SLUG: "chopin-test",
			GITHUB_APP_CLIENT_ID: "client-id",
			GITHUB_APP_CLIENT_SECRET: "client-secret",
			GITHUB_ALLOWED_USERS: "",
			GITHUB_ALLOWED_ORGANIZATIONS: "",
			PORT: String(port),
			SESSION_ENCRYPTION_KEY: "22".repeat(32),
			SERVER_HOST: "127.0.0.1",
			STORAGE_DRIVER: "postgres",
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	running.push(child);
	let text = "";
	for (let stream of [child.stdout, child.stderr] as ReadableStream<Uint8Array>[]) {
		void (async () => {
			for await (let chunk of stream) text += new TextDecoder().decode(chunk);
		})();
	}
	return { child, port, output: () => text };
}

async function health(port: number, path: "live" | "ready"): Promise<[number, string] | undefined> {
	try {
		let response = await fetch(`http://127.0.0.1:${port}/api/health/${path}`);
		return [response.status, await response.text()];
	} catch {
		return undefined;
	}
}

async function until<T>(
	what: string,
	read: () => Promise<T | undefined | false> | T | undefined | false,
	ms = 15_000,
): Promise<T> {
	let deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		let value = await read();
		if (value) return value;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

if (database) {
	describe("postgres hand-over between two processes", () => {
		let sql: SQL;
		let lease = async () => {
			let [row] = await sql<{ owner: string; fencing: string; free: boolean }[]>`
				SELECT owner, fencing::text, expires_at <= clock_timestamp() AS free
				FROM storage_leases WHERE name = 'chopin:writer'
			`;
			return row;
		};

		let migrate = async () => {
			let setup = new PostgresStorage(database!);
			await setup.migrate();
			await setup.close();
			sql = new SQL(database!);
		};

		afterEach(async () => {
			await sql?.close();
		});

		it(
			"a second process waits in standby beside the holder, answers files at once, and holds the rest",
			async () => {
				await migrate();
				let holder = spawn(9161, { HANDOVER: "wait" });
				await until(
					"the holder to be ready",
					async () => (await health(9161, "ready"))?.[0] === 200,
				);
				let before = await lease();
				let waiting = spawn(9162, { HANDOVER: "wait" });
				await until(
					"the standby to answer",
					async () => (await health(9162, "live"))?.[1] === "standby",
				);

				expect(await health(9162, "ready")).toEqual([503, "standby"]);
				let asset = await fetch("http://127.0.0.1:9162/assets/app-abcd1234.js");
				expect([asset.status, await asset.text()]).toEqual([200, "export {};"]);
				let missing = await fetch("http://127.0.0.1:9162/assets/gone-abcd1234.js");
				expect(missing.status).toBe(404);

				let held = fetch("http://127.0.0.1:9162/api/session");
				let answered = false;
				void held.then(() => answered = true);
				// An upgrade is held before the server decides about it, as any request is.
				let socket = new WebSocket("ws://127.0.0.1:9162/ws?room=none");
				let upgradeAnswered = false;
				socket.addEventListener("error", () => upgradeAnswered = true);
				socket.addEventListener("close", () => upgradeAnswered = true);
				socket.addEventListener("open", () => upgradeAnswered = true);
				await Bun.sleep(700);
				expect(answered).toBe(false);
				expect(upgradeAnswered).toBe(false);
				// It waited: still alive, and the lease is the holder's, untouched.
				expect(waiting.child.exitCode).toBeNull();
				let during = await lease();
				expect(during).toMatchObject({ owner: before!.owner, fencing: before!.fencing });
				expect(waiting.output()).toContain("waiting for the writer lease");
				expect(waiting.output()).not.toContain("safety deadline");

				holder.child.kill("SIGTERM");
				expect(await holder.child.exited).toBe(0);
				await until(
					"the second process to be ready",
					async () => (await health(9162, "ready"))?.[0] === 200,
				);
				let session = await held;
				expect(session.status).toBe(200);
				expect(await session.json()).toEqual({ user: null, agent: false });
				let after = await lease();
				expect(after!.owner).not.toBe(before!.owner);
				expect(Number(after!.fencing)).toBe(Number(before!.fencing) + 1);
				await until("the held upgrade to be answered", () => upgradeAnswered);
				expect(waiting.output()).toContain("held 2 request(s) while waiting");
			},
			40_000,
		);

		it(
			"takes the lease within a second of the holder's release, and is ready within the budget of it",
			async () => {
				await migrate();
				let holder = spawn(9163, { HANDOVER: "wait" });
				await until(
					"the holder to be ready",
					async () => (await health(9163, "ready"))?.[0] === 200,
				);
				let waiting = spawn(9164, { HANDOVER: "wait" });
				await until(
					"the standby to answer",
					async () => (await health(9164, "live"))?.[1] === "standby",
				);

				let first = await lease();
				holder.child.kill("SIGTERM");
				// The lease is free for only as long as the waiting process takes to notice, which a busy
				// machine can make shorter than one look: a new owner is the release seen late.
				let released = await until("the release", async () => {
					let current = await lease();
					return current && (current.free || current.owner !== first!.owner) && performance.now();
				});
				let took = await until("a new owner", async () => {
					let current = await lease();
					return current && !current.free && current.owner !== first!.owner && performance.now();
				});
				let ready = await until(
					"ready",
					async () => (await health(9164, "ready"))?.[0] === 200 && performance.now(),
				);
				console.info(
					`hand-over: lease taken ${Math.round(took - released)} ms after the release was seen, `
						+ `ready ${Math.round(ready - released)} ms after`,
				);
				expect(took - released).toBeLessThan(1_000);
				expect(ready - released).toBeLessThan(1_500);
				expect(await holder.child.exited).toBe(0);
				expect(waiting.child.exitCode).toBeNull();
			},
			40_000,
		);

		it(
			"the holder answers no request with an error through its cut, and nothing after it releases the lease",
			async () => {
				await migrate();
				let holder = spawn(9165, { HANDOVER: "wait", HANDOVER_UNREADY_MS: "300" });
				await until(
					"the holder to be ready",
					async () => (await health(9165, "ready"))?.[0] === 200,
				);
				let answers: { at: number; status: number; close: string | null }[] = [];
				let refused: number[] = [];
				let probe = { stopped: false };
				let probing = (async () => {
					while (!probe.stopped) {
						let path = answers.length % 2 ? "/api/session" : "/api/health/live";
						try {
							let response = await fetch(`http://127.0.0.1:9165${path}`, { keepalive: false });
							answers.push({
								at: performance.now(),
								status: response.status,
								close: response.headers.get("connection"),
							});
							await response.text();
						} catch {
							refused.push(performance.now());
						}
						await Bun.sleep(5);
					}
				})();
				await Bun.sleep(100);
				let ready: string[] = [];
				// One check before the signal, so the order below does not depend on how fast the loop starts.
				ready.push("200 ready");
				expect(await health(9165, "ready")).toEqual([200, "ready"]);
				let checking = (async () => {
					while (!probe.stopped) {
						let answer = await health(9165, "ready");
						if (answer) ready.push(`${answer[0]} ${answer[1]}`);
						await Bun.sleep(20);
					}
				})();
				let termAt = performance.now();
				holder.child.kill("SIGTERM");
				let released = await until(
					"the release",
					async () => (await lease())?.free && performance.now(),
				);
				expect(await holder.child.exited).toBe(0);
				probe.stopped = true;
				await Promise.all([probing, checking]);

				expect(answers.every(answer => answer.status === 200)).toBe(true);
				// From SIGTERM on, every answer asks the proxy to close its connection; before it, none does.
				expect(answers.filter(answer => answer.at < termAt).every(answer => answer.close === null))
					.toBe(true);
				let after = answers.filter(answer => answer.at > termAt + 30);
				expect(after.length).toBeGreaterThan(5);
				expect(after.every(answer => answer.close === "close")).toBe(true);
				// Readiness went off only for the fixed window before the cut, and the holder kept serving.
				let draining = ready.filter(line => line === "503 draining").length;
				expect(ready[0]).toBe("200 ready");
				expect(draining).toBeGreaterThanOrEqual(1);
				let last = answers.at(-1)!.at;
				expect(last).toBeLessThan(released + 50);
				expect(released - termAt).toBeGreaterThanOrEqual(300);
				let log = holder.output();
				expect(log).toMatch(
					/chopin: \d+ readiness check\(s\) answered not ready in the 300 ms window/,
				);
				expect(log).toContain("cut finished");
				// Every refused dial came after the listener stopped, which was after the window.
				for (let at of refused) expect(at).toBeGreaterThan(termAt + 300);
			},
			40_000,
		);

		it(
			"a process stopped while it waits leaves at once, taking nothing and leaving the holder's lease alone",
			async () => {
				await migrate();
				spawn(9166, { HANDOVER: "wait" });
				await until(
					"the holder to be ready",
					async () => (await health(9166, "ready"))?.[0] === 200,
				);
				let before = await lease();
				let waiting = spawn(9167, { HANDOVER: "wait" });
				await until(
					"the standby to answer",
					async () => (await health(9167, "live"))?.[1] === "standby",
				);
				waiting.child.kill("SIGTERM");
				expect(await waiting.child.exited).toBe(0);
				expect(await health(9167, "live")).toBeUndefined();
				expect(await lease()).toMatchObject({ owner: before!.owner, fencing: before!.fencing });
				expect(await health(9166, "ready")).toEqual([200, "ready"]);
			},
			40_000,
		);

		it("takes over from a holder that died, as soon as its lease has expired", async () => {
			await migrate();
			let holder = spawn(9168, { HANDOVER: "wait" });
			await until("the holder to be ready", async () => (await health(9168, "ready"))?.[0] === 200);
			spawn(9169, { HANDOVER: "wait" });
			await until(
				"the standby to answer",
				async () => (await health(9169, "live"))?.[1] === "standby",
			);
			holder.child.kill("SIGKILL");
			await holder.child.exited;
			// The lease stays held until its time runs out, and the waiting process only waits.
			await Bun.sleep(300);
			expect(await health(9169, "ready")).toEqual([503, "standby"]);
			await sql`UPDATE storage_leases SET expires_at = clock_timestamp() WHERE name = 'chopin:writer'`;
			await until(
				"the standby to be ready",
				async () => (await health(9169, "ready"))?.[0] === 200,
			);
		}, 40_000);

		it("without HANDOVER=wait a second process still exits 1 while the lease is held", async () => {
			await migrate();
			spawn(9170);
			await until("the holder to be ready", async () => (await health(9170, "ready"))?.[0] === 200);
			let second = spawn(9171);
			expect(await second.child.exited).toBe(1);
			expect(second.output()).toContain("another Chopin instance owns the database");
		}, 40_000);
	});
}
