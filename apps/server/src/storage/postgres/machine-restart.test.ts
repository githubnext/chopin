import { describe, expect, it } from "bun:test";

import { Machines } from "../../auth/machines";
import { contractId } from "../contract-support";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

function machines(storage: PostgresStorage, refreshed: string[]) {
	return new Machines(storage, () => new Date(), {
		key: new Uint8Array(32).fill(9),
		origin: "https://chopin.test",
		clientId: "client",
		refresh: async token => {
			refreshed.push(token);
			return {
				accessToken: "ghu_after_restart",
				accessExpiresIn: 28_800,
				refreshToken: "ghr_after_restart",
				refreshExpiresIn: 15_897_600,
			};
		},
	});
}

if (url) {
	describe("PostgreSQL machine credentials", () => {
		it("authenticate and refresh in a new process against the same database", async () => {
			let refreshed: string[] = [];
			let first = new PostgresStorage(url);
			await first.migrate();
			let userId = contractId("machine-restart-owner");
			await first.users.put({ id: userId, login: "mona", avatarUrl: "", now: new Date() });
			let paired = await machines(first, refreshed).pair({
				userId,
				label: "laptop",
				repositories: [],
				autoRun: false,
				// Already expired, so the next process must refresh it with the stored refresh token.
				grant: {
					accessToken: "ghu_before_restart",
					accessExpiresIn: 1,
					refreshToken: "ghr_before_restart",
					refreshExpiresIn: 15_897_600,
				},
			});
			await first.close();

			let second = new PostgresStorage(url);
			try {
				let restarted = machines(second, refreshed);
				let machine = await restarted.authenticate(paired.token);
				expect(await restarted.use(machine, async token => token)).toBe("ghu_after_restart");
				expect(refreshed).toEqual(["ghr_before_restart"]);
				expect((await second.machines.get(machine.id))?.credentials?.revision).toBe(2);
			} finally {
				await second.close();
			}
		});
	});
} else {
	it.skip("needs TEST_DATABASE_URL", () => {});
}
