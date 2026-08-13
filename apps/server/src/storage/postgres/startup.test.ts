import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { PostgresStorage } from "./adapter";

import type { Subprocess } from "bun";

let database = process.env.TEST_DATABASE_URL;
let running: Subprocess[] = [];

afterEach(async () => {
	for (let child of running) child.kill();
	await Promise.all(running.map(child => child.exited));
	running = [];
});

function spawn(
	port: number,
	stderr: "ignore" | "pipe" = "ignore",
	extra: Record<string, string> = {},
): Subprocess {
	let child = Bun.spawn(["bun", join(import.meta.dir, "../../main.ts")], {
		env: {
			...process.env,
			AGENT: "off",
			APP_ORIGIN: `http://127.0.0.1:${port}`,
			DATABASE_URL: database!,
			GITHUB_OAUTH_CLIENT_ID: "client-id",
			GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
			PORT: String(port),
			SESSION_ENCRYPTION_KEY: "22".repeat(32),
			SERVER_HOST: "127.0.0.1",
			STORAGE_DRIVER: "postgres",
			...extra,
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
			let first = spawn(9071);
			await ready(9071);
			let session = await fetch("http://127.0.0.1:9071/api/session");
			expect(await session.json()).toEqual({ user: null, agent: false });

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
