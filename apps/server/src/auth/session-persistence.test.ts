import { describe, expect, it } from "bun:test";

import { GitHubError, GitHubTokenError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { Sessions } from "./session";

import type { GitHubTokenGrant } from "../github/client";
import type { StoredWebSession } from "../storage/model";

let persistence = {
	key: new Uint8Array(32).fill(7),
	origin: "https://chopin.test",
	clientId: "test-app",
};
let grant: GitHubTokenGrant = {
	accessToken: "ghu_persisted_secret",
	accessExpiresIn: 28_800,
	refreshToken: "ghr_persisted_secret",
	refreshExpiresIn: 15_897_600,
};

async function fixture() {
	let storage = new MemoryStorage();
	let now = new Date("2026-08-13T12:00:00.000Z");
	let clock = () => now;
	await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
	let sessions = new Sessions(storage, true, clock, { persistence });
	let issued = await sessions.issue("U_test", grant);
	let cookie = issued.cookie.split(";", 1)[0]!;
	let request = new Request(`${persistence.origin}/api/session`, { headers: { cookie } });
	return {
		storage,
		sessions,
		issued,
		request,
		clock,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
	};
}

describe("encrypted hosted sessions", () => {
	it("restores only with the browser proof and never exposes ciphertext in session metadata", async () => {
		let { storage, issued, request, clock } = await fixture();
		let saved = (await storage.sessions.get(issued.id, clock()))!;
		expect(saved.credentials!.secretHash).toHaveLength(32);
		let ciphertext = Buffer.from(saved.credentials!.ciphertext).toString();
		expect(ciphertext).not.toContain(grant.accessToken);
		expect(ciphertext).not.toContain(grant.refreshToken);
		expect(ciphertext).not.toContain(request.headers.get("cookie")!.split(".")[1]!);
		let restarted = new Sessions(storage, true, clock, { persistence });
		expect(await restarted.resolve(issued.id)).toBeUndefined();
		expect(await restarted.forUser("U_test")).toBeUndefined();
		let wrong = new Request(request, {
			headers: {
				cookie: `${restarted.cookieName}=${issued.id}.${Buffer.alloc(32, 8).toString("base64url")}`,
			},
		});
		expect(await restarted.authenticate(wrong)).toBeUndefined();
		expect(await restarted.forUser("U_test")).toBeUndefined();
		let restored = (await restarted.authenticate(request))!;
		expect(restored.access.token).toBe(grant.accessToken);
		expect(restored.session).toEqual({
			id: issued.id,
			userId: "U_test",
			createdAt: clock(),
			expiresAt: issued.expiresAt,
		});
	});

	it("rejects another key, deployment or GitHub App", async () => {
		let { storage, request, clock } = await fixture();
		for (
			let changed of [
				{ ...persistence, key: new Uint8Array(32).fill(8) },
				{ ...persistence, origin: "https://preview.test" },
				{ ...persistence, clientId: "another-app" },
			]
		) {
			let restarted = new Sessions(storage, true, clock, { persistence: changed });
			expect(await restarted.authenticate(request)).toBeUndefined();
		}
	});

	it("authenticates the ciphertext, identity, lifetime, verifier and revision together", async () => {
		let { storage, issued, request, clock } = await fixture();
		let saved = (await storage.sessions.get(issued.id, clock()))!;
		let mutations: ((row: StoredWebSession) => void)[] = [
			row => {
				row.credentials!.ciphertext[20]! ^= 1;
			},
			row => {
				row.userId = "another-user";
			},
			row => {
				row.id = crypto.randomUUID();
			},
			row => {
				row.createdAt = new Date(row.createdAt.getTime() - 1);
			},
			row => {
				row.expiresAt = new Date(row.expiresAt.getTime() + 1);
			},
			row => {
				row.credentials!.secretHash[0]! ^= 1;
			},
			row => {
				row.credentials!.revision++;
			},
		];
		for (let mutate of mutations) {
			let altered = structuredClone(saved);
			mutate(altered);
			storage.sessions.get = async () => altered;
			let restarted = new Sessions(storage, true, clock, { persistence });
			expect(await restarted.authenticate(request)).toBeUndefined();
		}
	});

	it("shares concurrent restoration and refresh, persisting the rotated token before returning", async () => {
		let { storage, request, clock, advance, issued } = await fixture();
		advance(8 * 60 * 60 * 1_000);
		let refreshes = 0;
		let restarted = new Sessions(storage, true, clock, {
			persistence,
			refresh: async token => {
				expect(token).toBe(grant.refreshToken);
				refreshes++;
				return { ...grant, accessToken: "ghu_rotated", refreshToken: "ghr_rotated" };
			},
		});
		let restored = await Promise.all(
			Array.from({ length: 8 }, () => restarted.authenticate(request)),
		);
		expect(refreshes).toBe(1);
		for (let result of restored) {
			expect(result?.access).toMatchObject({ token: "ghu_rotated", revision: 2 });
		}
		let again = new Sessions(storage, true, clock, { persistence });
		expect((await again.authenticate(request))?.access.token).toBe("ghu_rotated");
		expect((await again.authenticate(request))?.session.expiresAt).toEqual(issued.expiresAt);
		advance(30 * 24 * 60 * 60 * 1_000);
		expect(await new Sessions(storage, true, clock, { persistence }).authenticate(request))
			.toBeUndefined();
	});

	it("can durably log out immediately after restart without refreshing or authorizing", async () => {
		let { storage, issued, request, clock, advance } = await fixture();
		advance(8 * 60 * 60 * 1_000);
		let restarted = new Sessions(storage, true, clock, {
			persistence,
			refresh: async () => {
				throw new Error("must not contact GitHub");
			},
			authorize: async () => {
				throw new Error("must not contact GitHub");
			},
		});
		expect(await restarted.revoke(request)).toBe(issued.id);
		expect(await new Sessions(storage, true, clock, { persistence }).authenticate(request))
			.toBeUndefined();
	});

	it("does not revive a logout while a rotated credential write is in flight", async () => {
		let { storage, issued, request, clock, advance } = await fixture();
		advance(8 * 60 * 60 * 1_000);
		let started = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let rotate = storage.sessions.rotate;
		storage.sessions.rotate = async (...args) => {
			started.resolve();
			await release.promise;
			return rotate(...args);
		};
		let restarted = new Sessions(storage, true, clock, { persistence, refresh: async () => grant });
		let authenticating = restarted.authenticate(request);
		await started.promise;
		await restarted.revoke(request);
		release.resolve();
		expect(await authenticating).toBeUndefined();
		expect(await storage.sessions.get(issued.id, clock())).toBeUndefined();
		expect(await new Sessions(storage, true, clock, { persistence }).authenticate(request))
			.toBeUndefined();
	});

	it("blocks restoration after a failed logout write until durable deletion succeeds", async () => {
		let { storage, sessions, request, clock } = await fixture();
		let remove = storage.sessions.delete;
		storage.sessions.delete = async () => {
			throw new Error("database unavailable");
		};
		await expect(sessions.revoke(request)).rejects.toThrow("database unavailable");
		expect(await sessions.authenticate(request)).toBeUndefined();
		storage.sessions.delete = remove;
		await sessions.revoke(request);
		expect(await new Sessions(storage, true, clock, { persistence }).authenticate(request))
			.toBeUndefined();
	});

	it("retains sessions on temporary authorization failures and durably removes revoked access", async () => {
		let { storage, issued, request, clock } = await fixture();
		let restarted = new Sessions(storage, true, clock, {
			persistence,
			authorize: async () => {
				throw new GitHubError("temporary failure", 503);
			},
		});
		await expect(restarted.authenticate(request)).rejects.toMatchObject({ status: 503 });
		expect(await storage.sessions.get(issued.id, clock())).toBeDefined();
		restarted = new Sessions(storage, true, clock, { persistence, authorize: async () => false });
		expect(await restarted.authenticate(request)).toBeUndefined();
		expect(await storage.sessions.get(issued.id, clock())).toBeUndefined();
	});

	it("removes a rejected refresh token and a rotated token that could not be saved", async () => {
		for (let failure of ["refresh", "storage"]) {
			let { storage, issued, request, clock, advance } = await fixture();
			advance(8 * 60 * 60 * 1_000);
			storage.sessions.rotate = async () => {
				throw new Error("database unavailable");
			};
			let restarted = new Sessions(storage, true, clock, {
				persistence,
				refresh: async () => {
					if (failure === "refresh") throw new GitHubTokenError("rejected", 401, true);
					return grant;
				},
			});
			expect(await restarted.authenticate(request)).toBeUndefined();
			expect(await storage.sessions.get(issued.id, clock())).toBeUndefined();
		}
	});
});
