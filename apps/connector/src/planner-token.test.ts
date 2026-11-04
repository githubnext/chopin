import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plannerTokenFile } from "./planner-token";

const MINUTE = 60_000;
let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const token = (n: number) => `chopin_p_${String(n).padStart(43, "P")}`;

async function until(condition: () => boolean | Promise<boolean>, withinMs = 3_000) {
	for (let deadline = Date.now() + withinMs; Date.now() < deadline; await Bun.sleep(10)) {
		if (await condition()) return;
	}
	throw new Error("timed out");
}

/** A Chopin that issues a numbered Planner credential each time the machine asks, or refuses. */
async function chopin(respond?: (n: number) => Response | undefined) {
	let asked: Array<{ authorization: string | null; body: unknown }> = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			asked.push({
				authorization: request.headers.get("authorization"),
				body: await request.json(),
			});
			let refused = respond?.(asked.length);
			if (refused) return refused;
			return Response.json({
				token: token(asked.length),
				expiresAt: Date.now() + 15 * MINUTE,
				document: { id: "D_1", repository: "octo-org/score" },
			});
		},
	});
	cleanups.push(() => server.stop(true));
	let directory = await mkdtemp(join(tmpdir(), "planner-token-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return {
		asked,
		url: `http://127.0.0.1:${server.port}`,
		file: join(directory, "D_1.planner-token"),
	};
}

const read = async (file: string) => (await readFile(file, "utf8")).trim();

test("writes the launch's credential to a private file and replaces it before each expires, for as long as the backend runs", async () => {
	let remote = await chopin();
	// Each credential lives 15 minutes; renewing 14.99 minutes before that ends makes it every few
	// milliseconds here, which stands for the hours a link may be down.
	let renewBeforeMs = 15 * MINUTE - 40;
	let tokens = await plannerTokenFile({
		url: remote.url,
		machine: "machine-token",
		document: "https://chopin.test/octo-org/score/plan",
		file: remote.file,
		first: { token: token(0), expiresAt: Date.now() + 15 * MINUTE },
		renewBeforeMs,
		floorMs: 0,
	});
	expect(tokens?.file).toBe(remote.file);
	expect(((await stat(remote.file)).mode & 0o777).toString(8)).toBe("600");
	expect(await read(remote.file)).toBe(token(0));

	await until(() => remote.asked.length >= 6);
	expect(remote.asked.every(call =>
		call.authorization === "Bearer machine-token"
		&& JSON.stringify(call.body)
			=== JSON.stringify({ document: "https://chopin.test/octo-org/score/plan" })
	)).toBe(true);
	// The file always holds the newest credential, and every one handed out is known, to be masked.
	let newest = remote.asked.length;
	expect(tokens!.secrets().slice(0, 3)).toEqual([token(0), token(1), token(2)]);
	expect(tokens!.secrets().length).toBeGreaterThanOrEqual(newest);

	await tokens!.stop();
	expect(await stat(remote.file).catch(() => "missing")).toBe("missing");
	let after = remote.asked.length;
	await Bun.sleep(150);
	expect(remote.asked.length).toBe(after);
});

test("replaces a credential that is already expired when it starts at once", async () => {
	let remote = await chopin();
	let tokens = await plannerTokenFile({
		url: remote.url,
		machine: "machine-token",
		document: "D_1",
		file: remote.file,
		first: { token: token(0), expiresAt: Date.now() - 3 * 60 * MINUTE },
	});
	await until(async () => (await read(remote.file)) === token(1));
	await tokens!.stop();
});

test("keeps the file it has while Chopin cannot be reached, tries again, and replaces it once it can", async () => {
	let remote = await chopin(n => n <= 2 ? new Response("down", { status: 503 }) : undefined);
	let tokens = await plannerTokenFile({
		url: remote.url,
		machine: "machine-token",
		document: "D_1",
		file: remote.file,
		first: { token: token(0), expiresAt: Date.now() - 1 },
		retryMs: 20,
	});
	await until(() => remote.asked.length >= 3);
	await until(async () => (await read(remote.file)) === token(3));
	await tokens!.stop();
});

test("deletes the file and stops asking once Chopin refuses the machine for good", async () => {
	let remote = await chopin(() => Response.json({ error: "machine-revoked" }, { status: 401 }));
	let tokens = await plannerTokenFile({
		url: remote.url,
		machine: "machine-token",
		document: "D_1",
		file: remote.file,
		first: { token: token(0), expiresAt: Date.now() - 1 },
		retryMs: 20,
	});
	await until(async () => !(await stat(remote.file).catch(() => undefined)));
	let asked = remote.asked.length;
	await Bun.sleep(120);
	expect(remote.asked.length).toBe(asked);
	expect(asked).toBe(1);
	await tokens!.stop();
});

test("does not ask in a loop when the machine's clock is far ahead of Chopin's, and remembers only recent credentials", async () => {
	let skew = 11 * MINUTE;
	let asked = 0;
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			asked++;
			return Response.json({
				token: token(asked),
				expiresAt: Date.now() - skew + 15 * MINUTE,
				document: { id: "D_1" },
			});
		},
	});
	cleanups.push(() => server.stop(true));
	let directory = await mkdtemp(join(tmpdir(), "planner-token-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	let tokens = await plannerTokenFile({
		url: `http://127.0.0.1:${server.port}`,
		machine: "machine-token",
		document: "D_1",
		file: join(directory, "D_1.planner-token"),
		first: { token: token(0), expiresAt: Date.now() - skew + 15 * MINUTE },
	});
	await Bun.sleep(600);
	// The one renewal the skewed expiry makes due at once, and then a pause, not a request storm.
	expect(asked).toBeLessThanOrEqual(2);
	await tokens!.stop();
});

test("remembers only the newest credentials to mask", async () => {
	let remote = await chopin();
	let tokens = await plannerTokenFile({
		url: remote.url,
		machine: "machine-token",
		document: "D_1",
		file: remote.file,
		first: { token: token(0), expiresAt: Date.now() + 15 * MINUTE },
		renewBeforeMs: 15 * MINUTE - 5,
		floorMs: 0,
	});
	await until(() => remote.asked.length >= 20);
	expect(tokens!.secrets().length).toBeLessThanOrEqual(8);
	expect(tokens!.secrets().at(-1)).toMatch(/^chopin_p_/);
	await tokens!.stop();
});

test("stops at once, and removes the file, while a request for a new credential is still unanswered", async () => {
	let asked = 0;
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			asked++;
			await new Promise(() => {});
			return new Response();
		},
	});
	cleanups.push(() => server.stop(true));
	let directory = await mkdtemp(join(tmpdir(), "planner-token-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	let file = join(directory, "D_1.planner-token");
	let tokens = await plannerTokenFile({
		url: `http://127.0.0.1:${server.port}`,
		machine: "machine-token",
		document: "D_1",
		file,
		first: { token: token(0), expiresAt: Date.now() - 1 },
	});
	await until(() => asked > 0);
	let outcome = await Promise.race([
		tokens!.stop().then(() => "stopped"),
		Bun.sleep(2_000).then(() => "still waiting"),
	]);
	expect(outcome).toBe("stopped");
	expect(await stat(file).catch(() => "missing")).toBe("missing");
});

test("keeps the credential file private even when a temporary file of the same name was left wider", async () => {
	let directory = await mkdtemp(join(tmpdir(), "planner-token-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	let file = join(directory, "D_1.planner-token");
	await writeFile(`${file}.${process.pid}.tmp`, "old\n", { mode: 0o644 });
	let tokens = await plannerTokenFile({
		url: "http://127.0.0.1:9",
		machine: "machine-token",
		document: "D_1",
		file,
		first: { token: token(0), expiresAt: Date.now() + 15 * MINUTE },
	});
	expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
	expect(await read(file)).toBe(token(0));
	await tokens!.stop();
});
