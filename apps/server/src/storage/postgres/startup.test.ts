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
		it("resets sessions only after owning the writer lease", async () => {
			let setup = new PostgresStorage(database);
			await setup.migrate();
			await setup.close();
			let first = spawn(9071);
			await ready(9071);
			let session = await fetch("http://127.0.0.1:9071/api/session");
			expect(await session.json()).toEqual({ user: null, agent: false });

			let storage = new PostgresStorage(database);
			let now = new Date();
			let userId = `user-${crypto.randomUUID()}`;
			let sessionId = crypto.randomUUID();
			let channelId = crypto.randomUUID();
			await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await storage.sessions.create({
				id: sessionId,
				userId,
				expiresAt: new Date(now.getTime() + 60_000),
				createdAt: now,
			});
			await storage.channels.create({
				id: channelId,
				repositoryId: `repository-${crypto.randomUUID()}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Plan",
				createdBy: userId,
				now,
			});
			let owner = await storage.channels.claimAgentOwner(channelId, sessionId, now);
			await storage.channels.updateAgentContext({
				channelId,
				ownerSessionId: sessionId,
				generation: owner.generation,
				summary: "keep this",
				transcriptCursor: 4,
				status: "ready",
				now,
			});

			let refused = spawn(9072, "pipe");
			expect(await refused.exited).toBe(1);
			let reason = await new Response(refused.stderr as ReadableStream).text();
			expect(reason).toContain("another Chopin instance owns the database");
			expect(await storage.sessions.get(sessionId, now)).toBeDefined();
			expect((await storage.collaboration.load(channelId, now))!.agent!.ownerSessionId)
				.toBe(sessionId);

			first.kill("SIGTERM");
			expect(await first.exited).toBe(0);
			let replacement = spawn(9072);
			await ready(9072);
			expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
			expect((await storage.collaboration.load(channelId, now))!.agent).toMatchObject({
				ownerSessionId: undefined,
				generation: owner.generation,
				summary: "keep this",
				transcriptCursor: 4,
				status: "unavailable",
			});
			replacement.kill("SIGTERM");
			expect(await replacement.exited).toBe(0);
			await storage.close();
		});
	});
} else {
	describe("postgres server lifecycle", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
