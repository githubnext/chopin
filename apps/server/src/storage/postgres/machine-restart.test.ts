import { describe, expect, it } from "bun:test";

import { Machines } from "../../auth/machines";
import { GitHubTokenError } from "../../github/client";
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

		it("keep the rotation another instance saved when GitHub refuses the spent refresh token", async () => {
			// GitHub refresh tokens are single-use: the second instance to spend one is refused.
			let spent = new Set<string>();
			let issued = 0;
			let github = async (token: string) => {
				if (spent.has(token)) {
					throw new GitHubTokenError("GitHub rejected the token refresh", 400, true);
				}
				spent.add(token);
				issued++;
				return {
					accessToken: `ghu_rotated_${issued}`,
					accessExpiresIn: 28_800,
					refreshToken: `ghr_rotated_${issued}`,
					refreshExpiresIn: 15_897_600,
				};
			};
			let reached = Promise.withResolvers<void>();
			let held = Promise.withResolvers<void>();
			let instance = (storage: PostgresStorage, refresh: typeof github) =>
				new Machines(storage, () => new Date(), {
					key: new Uint8Array(32).fill(9),
					origin: "https://chopin.test",
					clientId: "client",
					refresh,
				});
			let first = new PostgresStorage(url);
			let second = new PostgresStorage(url);
			try {
				await first.migrate();
				let userId = contractId("machine-race-owner");
				await first.users.put({ id: userId, login: "mona", avatarUrl: "", now: new Date() });
				let slow = instance(first, async token => {
					reached.resolve();
					await held.promise;
					return github(token);
				});
				let fast = instance(second, github);
				let paired = await slow.pair({
					userId,
					label: "laptop",
					repositories: [],
					autoRun: false,
					grant: {
						accessToken: "ghu_expired",
						accessExpiresIn: 1,
						refreshToken: "ghr_spent_once",
						refreshExpiresIn: 15_897_600,
					},
				});
				let late = slow.use(await slow.authenticate(paired.token), async token => token);
				await reached.promise;
				expect(await fast.use(await fast.authenticate(paired.token), async token => token))
					.toBe("ghu_rotated_1");
				held.resolve();
				expect(await late).toBe("ghu_rotated_1");
				let stored = await second.machines.get(paired.machine.id);
				expect(stored?.credentials?.revision).toBe(2);
				expect(stored?.reauthorizeAt).toBeUndefined();
				expect(spent).toEqual(new Set(["ghr_spent_once"]));
			} finally {
				held.resolve();
				await first.close();
				await second.close();
			}
		});
	});
} else {
	it.skip("needs TEST_DATABASE_URL", () => {});
}
