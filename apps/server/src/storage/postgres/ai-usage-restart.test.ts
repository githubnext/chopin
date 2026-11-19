import { describe, expect, it } from "bun:test";

import { AiUsage } from "../../ai/usage";
import { contractId } from "../contract-support";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

if (url) {
	describe("PostgreSQL AI usage across a restart", () => {
		it("marks a request sent by a process that stopped before recording its end unknown", async () => {
			let writer = contractId("writer");
			let first = new PostgresStorage(url);
			await first.migrate();
			let userId = contractId("ai-usage-restart");
			await first.users.put({ id: userId, login: "mona", avatarUrl: "", now: new Date() });
			let crashed = (await first.leases.acquire(writer, "first", 1_000))!;
			let sent = await new AiUsage({ storage: first, lease: () => crashed }).begin(
				{
					digest: new Uint8Array(32),
					launchId: contractId("launch"),
					launchDigest: new Uint8Array(32),
					userId,
					provider: "anthropic",
					expiresAt: new Date(Date.now() + 60_000),
				},
				new TextEncoder().encode(JSON.stringify({ model: "claude-test", messages: [] })),
			);
			await first.close();
			await Bun.sleep(1_100);

			let second = new PostgresStorage(url);
			try {
				let lease = (await second.leases.acquire(writer, "second", 60_000))!;
				expect(lease.fencing).toBeGreaterThan(crashed.fencing);
				let restarted = new AiUsage({ storage: second, lease: () => lease });
				expect((await second.aiUsage.get(sent.id))?.outcome).toBe("pending");
				expect(await restarted.retire()).toBe(1);
				expect(await second.aiUsage.get(sent.id)).toMatchObject({
					userId,
					provider: "anthropic",
					model: "claude-test",
					outcome: "unknown",
				});
				expect((await restarted.summary(userId)).models).toEqual([{
					provider: "anthropic",
					model: "claude-test",
					requests: 1,
					errors: 0,
					unknown: 1,
					tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}]);
			} finally {
				await second.close();
			}
		});
	});
}
