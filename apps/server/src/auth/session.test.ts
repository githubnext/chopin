import { describe, expect, it } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { OAuthAttempts, Sessions } from "./session";

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

describe("hosted login sessions", () => {
	it("stores only a secret hash and encrypted OAuth token", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		let key = new Uint8Array(32).fill(7);
		await storage.users.put({
			id: "U_test",
			login: "octocat",
			avatarUrl: "https://avatars.test/octocat",
			now,
		});
		let sessions = new Sessions(storage, key, true, () => now);
		let issued = await sessions.issue("U_test", "gho_plaintext_secret");
		let record = await stored(storage, issued.id, now);

		expect(issued.cookie).toContain("__Host-chopin_session=");
		expect(issued.cookie).toContain("HttpOnly");
		expect(issued.cookie).toContain("SameSite=Lax");
		expect(issued.cookie).toContain("Secure");
		expect(record.secretHash).toHaveLength(32);
		expect(Buffer.from(record.oauthToken).toString("utf8")).not.toContain("gho_plaintext_secret");

		let authenticated = await sessions.authenticate(request(pair(issued.cookie)));
		expect(authenticated?.user.login).toBe("octocat");
		expect(authenticated?.oauthToken).toBe("gho_plaintext_secret");
		expect(authenticated?.session.id).toBe(issued.id);
		expect((await sessions.resolve(issued.id))?.oauthToken).toBe("gho_plaintext_secret");
	});

	it("rejects the wrong secret, duplicate cookies and the wrong encryption key", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		let key = new Uint8Array(32).fill(3);
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, key, false, () => now);
		let issued = await sessions.issue("U_test", "gho_secret");
		let cookie = pair(issued.cookie);
		let id = cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
		let wrong = `${sessions.cookieName}=${id}.${Buffer.alloc(32, 9).toString("base64url")}`;

		expect(await sessions.authenticate(request(wrong))).toBeUndefined();
		expect(await sessions.authenticate(request(`${cookie}; ${cookie}`))).toBeUndefined();
		let otherKey = new Sessions(storage, new Uint8Array(32).fill(4), false, () => now);
		expect(await otherKey.authenticate(request(cookie))).toBeUndefined();
	});

	it("expires absolutely and revokes only a correctly authenticated cookie", async () => {
		let storage = new MemoryStorage();
		let now = new Date("2026-08-13T12:00:00.000Z");
		await storage.users.put({ id: "U_test", login: "mona", avatarUrl: "", now });
		let sessions = new Sessions(storage, new Uint8Array(32).fill(5), false, () => now);
		let issued = await sessions.issue("U_test", "gho_secret");
		let cookie = pair(issued.cookie);

		await sessions.revoke(request(`${sessions.cookieName}=wrong`));
		expect(await sessions.authenticate(request(cookie))).toBeDefined();
		await sessions.revoke(request(cookie));
		expect(await sessions.authenticate(request(cookie))).toBeUndefined();

		let replacement = await sessions.issue("U_test", "gho_secret");
		now = new Date(replacement.expiresAt);
		expect(await sessions.authenticate(request(pair(replacement.cookie)))).toBeUndefined();
		expect(sessions.clearCookie()).toContain("Max-Age=0");
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
