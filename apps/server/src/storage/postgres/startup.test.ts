import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresStorage } from "./adapter";

import type { Subprocess } from "bun";

let database = process.env.TEST_DATABASE_URL;
let running: Subprocess[] = [];
let scratch: string[] = [];

afterEach(async () => {
	for (let child of running) child.kill();
	await Promise.all(running.map(child => child.exited));
	running = [];
	await Promise.all(scratch.map(path => rm(path, { recursive: true, force: true })));
	scratch = [];
});

async function directory(): Promise<string> {
	let path = await mkdtemp(join(tmpdir(), "chopin-postgres-startup-"));
	scratch.push(path);
	return path;
}

function spawn(port: number, stderr: "ignore" | "pipe" = "ignore"): Subprocess {
	let child = Bun.spawn(["bun", join(import.meta.dir, "../../main.ts")], {
		env: {
			...process.env,
			AGENT: "off",
			DATABASE_URL: database!,
			DATA_DIR: scratch.at(-1)!,
			PORT: String(port),
			SERVER_HOST: "127.0.0.1",
			STORAGE_DRIVER: "postgres",
		},
		stdout: "ignore",
		stderr,
	});
	running.push(child);
	return child;
}

async function ready(port: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error(`server on ${port} did not become ready`);
}

if (database) {
	describe("postgres server lifecycle", () => {
		it("excludes a second writer and releases the lease on shutdown", async () => {
			let setup = new PostgresStorage(database);
			await setup.migrate();
			await setup.close();
			await directory();
			let first = spawn(9071);
			await ready(9071);

			let refused = spawn(9072, "pipe");
			expect(await refused.exited).toBe(1);
			let reason = await new Response(refused.stderr as ReadableStream).text();
			expect(reason).toContain("another Chopin instance owns the database");

			first.kill("SIGTERM");
			expect(await first.exited).toBe(0);
			let replacement = spawn(9072);
			await ready(9072);
			replacement.kill("SIGTERM");
			expect(await replacement.exited).toBe(0);
		});
	});
} else {
	describe("postgres server lifecycle", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
