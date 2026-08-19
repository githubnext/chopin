import { describe, expect, it } from "bun:test";

import { GitHubError, GitHubTokenError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { OAuthAttempts, Sessions } from "./session";

import type { GitHubTokenGrant } from "../github/client";

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

function request(cookie: string): Request {
	return new Request("https://chopin.test/api/session", { headers: { cookie } });
}

async function stored(storage: MemoryStorage, id: string, now: Date) {
	let value = await storage.sessions.get(id, now);
	if (!value) throw new Error("test session was not stored");
	return value;
}

function grant(accessToken: string, refreshToken = "ghr_refresh"): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken,
		refreshExpiresIn: 15_897_600,
	};
}

describe("hosted login sessions", () => {
	it("stores only registry metadata while credentials remain process-local", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({
			id: "U_test",
			login: "octocat",
			avatarUrl: "https://avatars.test/octocat",
			now,
		});
		let sessions = new Sessions(storage, true, () => now);
		let issued = await sessions.issue("U_test", grant("ghu_plaintext_secret"));
		let record = await stored(storage, issued.id, now);

		expect(issued.cookie).toContain("__Host-chopin_session=");
		expect(issued.cookie).toContain("HttpOnly");
		expect(issued.cookie).toContain("SameSite=Lax");
		expect(issued.cookie).toContain("Secure");
		expect(record).toEqual({
			id: issued.id,
			userId: "U_test",
			expiresAt: issued.expiresAt,
			createdAt: now,
		});

		let authenticated = await sessions.authenticate(request(pair(issued.cookie)));
		expect(authenticated?.user.login).toBe("octocat");
		expect(authenticated?.access.token).toBe("ghu_plaintext_secret");
		expect(authenticated?.access.revision).toBe(1);
		expect(authenticated?.session.id).toBe(issued.id);
		expect((await sessions.resolve(issued.id))?.access.token).toBe("ghu_plaintext_secret");

		let restarted = new Sessions(storage, true, () => now);
		expect(await restarted.authenticate(request(pair(issued.cookie)))).toBeUndefined();
		expect(await restarted.resolve(issued.id)).toBeUndefined();
	});

	it("rejects the wrong secret and duplicate cookies", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, false, () => now);
		let issued = await sessions.issue("U_test", grant("ghu_secret"));
		let cookie = pair(issued.cookie);
		let id = cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
		let wrong = `${sessions.cookieName}=${id}.${Buffer.alloc(32, 9).toString("base64url")}`;

		expect(await sessions.authenticate(request(wrong))).toBeUndefined();
		expect(await sessions.authenticate(request(`${cookie}; ${cookie}`))).toBeUndefined();
	});

	it("expires absolutely and revokes only a correctly authenticated cookie", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, false, () => now);
		let issued = await sessions.issue("U_test", grant("ghu_secret"));
		let cookie = pair(issued.cookie);

		await sessions.revoke(request(`${sessions.cookieName}=wrong`));
		expect(await sessions.authenticate(request(cookie))).toBeDefined();
		await sessions.revoke(request(cookie));
		expect(await sessions.authenticate(request(cookie))).toBeUndefined();

		let replacement = await sessions.issue("U_test", grant("ghu_secret"));
		now = new Date(replacement.expiresAt);
		expect(await sessions.authenticate(request(pair(replacement.cookie)))).toBeUndefined();
		expect(sessions.clearCookie()).toContain("Max-Age=0");
	});

	it("does not use an authenticated snapshot after logout", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, false, () => now);
		let issued = await sessions.issue("U_test", grant("ghu_secret"));
		let cookie = request(pair(issued.cookie));
		let authenticated = (await sessions.authenticate(cookie))!;
		await sessions.revoke(cookie);
		let calls = 0;

		await expect(sessions.use(authenticated, async () => {
			calls++;
		})).rejects.toMatchObject({ status: 401 });
		expect(calls).toBe(0);
	});

	it("retries a failed token-free registry deletion during cleanup", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let originalDelete = storage.sessions.delete;
		let fail = true;
		storage.sessions.delete = async id => {
			if (fail) {
				fail = false;
				throw new Error("temporary storage failure");
			}
			return originalDelete(id);
		};
		let sessions = new Sessions(storage, false, () => now);
		let issued = await sessions.issue("U_test", grant("ghu_secret"));

		await expect(sessions.revoke(request(pair(issued.cookie)))).rejects.toThrow(
			"temporary storage failure",
		);
		expect(await storage.sessions.get(issued.id, now)).toBeDefined();
		expect(await sessions.cleanupExpired()).toBe(0);
		expect(await storage.sessions.get(issued.id, now)).toBeUndefined();
	});

	it("serializes refreshes and rotates the process-local credential", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let refreshes = 0;
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async token => {
				refreshes++;
				expect(token).toBe("ghr_first");
				await Bun.sleep(10);
				return grant("ghu_second", "ghr_second");
			},
		});
		let issued = await sessions.issue("U_test", {
			...grant("ghu_first", "ghr_first"),
			accessExpiresIn: 60,
		});
		let cookie = request(pair(issued.cookie));

		let [first, second] = await Promise.all([
			sessions.authenticate(cookie),
			sessions.authenticate(cookie),
		]);
		expect(refreshes).toBe(1);
		expect(first?.access).toMatchObject({ token: "ghu_second", revision: 2 });
		expect(second?.access).toMatchObject({ token: "ghu_second", revision: 2 });
		expect(await stored(storage, issued.id, now)).toMatchObject({
			id: issued.id,
			userId: "U_test",
		});
	});

	it("does not resurrect a session logged out during refresh", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let started = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async () => {
				started.resolve();
				await release.promise;
				return grant("ghu_second", "ghr_second");
			},
		});
		let issued = await sessions.issue("U_test", {
			...grant("ghu_first", "ghr_first"),
			accessExpiresIn: 60,
		});
		let authenticated = sessions.authenticate(request(pair(issued.cookie)));
		await started.promise;
		expect(await sessions.inspect(issued.id)).toBeUndefined();
		await sessions.revoke(request(pair(issued.cookie)));
		release.resolve();

		expect(await authenticated).toBeUndefined();
		expect(await storage.sessions.get(issued.id, now)).toBeUndefined();
	});

	it("retries one rejected API token with a rotated credential", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async () => grant("ghu_second", "ghr_second"),
		});
		let issued = await sessions.issue("U_test", grant("ghu_first", "ghr_first"));
		let authenticated = (await sessions.authenticate(request(pair(issued.cookie))))!;
		let attempted: string[] = [];

		let result = await sessions.use(authenticated, token => {
			attempted.push(token);
			if (token === "ghu_first") throw new GitHubError("rejected", 401);
			return Promise.resolve("accepted");
		});
		expect(result.value).toBe("accepted");
		expect(result.authenticated.access.revision).toBe(2);
		expect(attempted).toEqual(["ghu_first", "ghu_second"]);
		expect((await sessions.use(authenticated, token => Promise.resolve(token))).value)
			.toBe("ghu_second");
	});

	it("does not revoke a newer credential after a stale second 401", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let revision = 1;
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async () => {
				revision++;
				return grant(`ghu_${revision}`, `ghr_${revision}`);
			},
		});
		let issued = await sessions.issue("U_test", grant("ghu_1", "ghr_1"));
		let first = (await sessions.resolve(issued.id))!;
		let secondAttempt = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let stale = sessions.use(first, async token => {
			if (token === "ghu_1") throw new GitHubError("rejected", 401);
			secondAttempt.resolve();
			await release.promise;
			throw new GitHubError("stale rejection", 401);
		});
		await secondAttempt.promise;

		let second = (await sessions.resolve(issued.id))!;
		let current = await sessions.use(second, token => {
			if (token === "ghu_2") throw new GitHubError("rejected", 401);
			return Promise.resolve(token);
		});
		expect(current.value).toBe("ghu_3");
		release.resolve();
		await expect(stale).rejects.toMatchObject({ status: 503 });
		expect((await sessions.resolve(issued.id))?.access).toMatchObject({
			token: "ghu_3",
			revision: 3,
		});
	});

	it("retains transiently failed credentials but deletes a rejected refresh token", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let terminal = false;
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async () => {
				throw terminal
					? new GitHubTokenError("bad refresh", 401, true)
					: new GitHubTokenError("unavailable");
			},
		});
		let issued = await sessions.issue("U_test", {
			...grant("ghu_first", "ghr_first"),
			accessExpiresIn: 1,
		});
		now = new Date(now.getTime() + 2_000);
		await expect(sessions.authenticate(request(pair(issued.cookie)))).rejects.toThrow(
			"unavailable",
		);
		expect(await storage.sessions.get(issued.id, now)).toBeDefined();

		terminal = true;
		expect(await sessions.authenticate(request(pair(issued.cookie)))).toBeUndefined();
		expect(await storage.sessions.get(issued.id, now)).toBeUndefined();
	});

	it("revokes a session that no longer passes external admission", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let allowed = true;
		let revoked: string[] = [];
		let sessions = new Sessions(storage, false, () => now, {
			authorize: async (user, token) => {
				expect(user.id).toBe("U_test");
				expect(token).toBe("ghu_secret");
				return allowed;
			},
			onRevoked: async id => {
				revoked.push(id);
			},
		});
		let issued = await sessions.issue("U_test", grant("ghu_secret"));
		let cookie = request(pair(issued.cookie));
		expect(await sessions.authenticate(cookie)).toBeDefined();

		allowed = false;
		expect(await sessions.authenticate(cookie)).toBeUndefined();
		expect(await storage.sessions.get(issued.id, now)).toBeUndefined();
		expect(revoked).toEqual([issued.id]);
	});

	it("retains a session when external admission is temporarily unavailable", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, false, () => now, {
			authorize: async () => {
				throw new GitHubError("membership unavailable", 503);
			},
		});
		let issued = await sessions.issue("U_test", grant("ghu_secret"));
		await expect(sessions.authenticate(request(pair(issued.cookie))))
			.rejects.toMatchObject({ status: 503 });
		expect(await storage.sessions.get(issued.id, now)).toBeDefined();
	});

	it("refreshes and retries a token rejected during external admission", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let attempts: string[] = [];
		let sessions = new Sessions(storage, false, () => now, {
			refresh: async () => grant("ghu_second", "ghr_second"),
			authorize: async (_user, token) => {
				attempts.push(token);
				if (token === "ghu_first") throw new GitHubError("expired", 401);
				return true;
			},
		});
		let issued = await sessions.issue("U_test", grant("ghu_first", "ghr_first"));
		let authenticated = await sessions.authenticate(request(pair(issued.cookie)));

		expect(authenticated?.access).toMatchObject({ token: "ghu_second", revision: 2 });
		expect(attempts).toEqual(["ghu_first", "ghu_second"]);
	});
});

describe("OAuth attempts", () => {
	it("carries state and the PKCE verifier in a short-lived encrypted cookie", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let attempts = new OAuthAttempts(new Uint8Array(32).fill(8), true, () => now);
		let issued = await attempts.issue();
		let recovered = await attempts.read(request(pair(issued.cookie)));

		expect(issued.state).toHaveLength(43);
		expect(issued.verifier).toHaveLength(43);
		expect(issued.challenge).toHaveLength(43);
		let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.verifier));
		expect(issued.challenge).toBe(Buffer.from(digest).toString("base64url"));
		expect(issued.cookie).toContain("__Host-chopin_oauth_state=");
		expect(issued.cookie).toContain("Path=/");
		expect(issued.cookie).not.toContain(issued.state);
		expect(recovered?.state).toBe(issued.state);
		expect(recovered?.verifier).toBe(issued.verifier);

		let cookie = pair(issued.cookie);
		let tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
		expect(await attempts.read(request(tampered))).toBeUndefined();
		now = new Date(issued.expiresAt);
		expect(await attempts.read(request(cookie))).toBeUndefined();
	});
});
