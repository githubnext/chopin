import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage } from "./contract-support";

import type { StorageFactory } from "./contract-support";

export function userContract(name: string, factory: StorageFactory) {
	describe(`${name} users`, () => {
		test("finds each login's newest row, whatever its casing, in one read", async () => {
			let storage = await openedStorage(factory);
			try {
				// A shared database keeps earlier tests' users, so every login is this test's own.
				let tag = crypto.randomUUID().slice(0, 8);
				let earlier = new Date("2026-03-01T10:00:00.000Z");
				let later = new Date("2026-03-02T10:00:00.000Z");
				// A login someone gave up stays on their row until they sign in again; the account
				// that took it signed in since, and its row is the one that owns the name now.
				await storage.users.put({
					id: id("user"),
					login: `mona_${tag}`,
					avatarUrl: "https://example.test/previous-holder",
					now: earlier,
				});
				let current = await storage.users.put({
					id: id("user"),
					login: `Mona_${tag}`,
					avatarUrl: "https://example.test/current-holder",
					now: later,
				});
				let hubot = await storage.users.put({
					id: id("user"),
					login: `hubot_${tag}`,
					avatarUrl: "https://example.test/hubot",
					now: earlier,
				});

				let found = await storage.users.byLogins([
					`MONA_${tag}`,
					`hubot_${tag}`,
					`nobody_${tag}`,
					`hubot_${tag}`,
				]);

				expect(found.map(user => [user.id, user.login, user.avatarUrl]).sort()).toEqual(
					[current, hubot].map(user => [user.id, user.login, user.avatarUrl]).sort(),
				);
				expect(await storage.users.byLogins([])).toEqual([]);
			} finally {
				await storage.close();
			}
		});
	});
}
