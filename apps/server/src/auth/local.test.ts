import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubClient } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { DeviceAuthorization } from "./device";
import { LocalCredentials } from "./local-store";
import { registerAuthRoutes } from "./routes";

import type { AuthConfig } from "./config";
import type { NativeSecrets } from "./local-store";

let roots: string[] = [];
afterEach(async () => {
	for (let root of roots) await rm(root, { recursive: true, force: true });
	roots = [];
});

function cookies(response: Response) {
	return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

function pair(cookie: string) {
	return cookie.split(";", 1)[0]!;
}

async function fixture(vaultFailure = false, initialInterval = 1) {
	let root = await mkdtemp(join(tmpdir(), "chopin-local-flow-"));
	roots.push(root);
	let values = new Map<string, string>();
	let native: NativeSecrets = {
		get: async ({ name }) => {
			if (vaultFailure) throw new Error("vault locked");
			return values.get(name) ?? null;
		},
		set: async ({ name, value }) => {
			if (vaultFailure) throw new Error("vault locked");
			values.set(name, value);
		},
		delete: async ({ name }) => values.delete(name),
	};
	let config: AuthConfig = {
		origin: "http://localhost:8790",
		appSlug: "test",
		clientId: "public",
		encryptionKey: new Uint8Array(32),
		local: { installation: "local-installation", credentialsDir: join(root, "config"), port: 8790 },
	};
	let storage = new MemoryStorage();
	let polls: string[] = [];
	let response = "authorization_pending";
	let outcomes: Array<{ error: string; interval?: number }> = [];
	let device = new DeviceAuthorization({
		fetch: async (input, init) => {
			let url = String(input);
			if (url.endsWith("/device/code")) {
				return Response.json({
					device_code: `private-${polls.length}`,
					user_code: "E2E1-0001",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: initialInterval,
				});
			}
			polls.push(new URLSearchParams(String(init?.body)).get("device_code")!);
			let outcome = outcomes.shift();
			return response === "granted"
				? Response.json({
					access_token: "ghu_local_private",
					refresh_token: "ghr_local_private",
					token_type: "bearer",
					expires_in: 28_800,
					refresh_token_expires_in: 15_897_600,
				})
				: Response.json(outcome ?? { error: response });
		},
	});
	let refreshes = 0;
	let rejectedRefresh = false;
	let userGate: { started: () => void; release: Promise<void> } | undefined;
	let userId = "U_one";
	let github = new GitHubClient({
		fetch: async (input, init) => {
			let url = String(input);
			if (url.endsWith("/user")) {
				userGate?.started();
				if (userGate) await userGate.release;
				return Response.json({
					node_id: userId,
					login: "one",
					avatar_url: "https://example.invalid/one",
				});
			}
			if (url.endsWith("/access_token")) {
				let params = new URLSearchParams(String(init?.body));
				refreshes++;
				expect(params.has("client_secret")).toBe(false);
				if (rejectedRefresh) return Response.json({ error: "bad_refresh_token" });
				return Response.json({
					access_token: "ghu_rotated",
					refresh_token: "ghr_rotated",
					token_type: "bearer",
					expires_in: 28_800,
					refresh_token_expires_in: 15_897_600,
				});
			}
			throw new Error(`unexpected GitHub path ${url}`);
		},
	});
	let credentials = new LocalCredentials(config.local!.credentialsDir, native, 20);
	let now = new Date();
	let intervals: number[] = [];
	let waits: Array<{ ms: number; release: () => void }> = [];
	let delay = (ms: number, signal: AbortSignal) =>
		new Promise<void>(resolve => {
			let release = () => resolve();
			intervals.push(ms);
			waits.push({ ms, release });
			signal.addEventListener("abort", release, { once: true });
		});
	let server = () => {
		let router = new Router();
		let auth = registerAuthRoutes(router, {
			config,
			storage,
			github,
			device,
			credentials,
			delay,
			agent: false,
			clock: () => now,
		});
		return { router, auth };
	};
	let request = async (
		router: Router,
		path: string,
		method = "GET",
		cookie = "",
		origin = config.origin,
		body?: unknown,
	) => {
		let response = await router.handle(
			new Request(`${config.origin}${path}`, {
				method,
				headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
			}),
		);
		return response!;
	};
	let wait = async (status: string, router: Router, cookie: string) => {
		for (let n = 0; n < 100; n++) {
			let answer = await request(router, "/auth/device", "GET", cookie);
			if ((await answer.json()).status === status) return;
			await Bun.sleep(2);
		}
		throw new Error(`attempt did not reach ${status}`);
	};
	return {
		root,
		config,
		storage,
		values,
		credentials,
		waits,
		intervals,
		server,
		request,
		wait,
		refreshes: () => refreshes,
		rejectRefresh: () => {
			rejectedRefresh = true;
		},
		polls,
		outcomes,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
		setVaultFailure: (value: boolean) => {
			vaultFailure = value;
		},
		setUserId: (id: string) => {
			userId = id;
		},
		pauseUser: () => {
			let started = Promise.withResolvers<void>();
			let release = Promise.withResolvers<void>();
			userGate = { started: () => started.resolve(), release: release.promise };
			return { started: started.promise, release: () => release.resolve() };
		},
		approve: () => {
			response = "granted";
		},
		deny: () => {
			response = "access_denied";
		},
	};
}

describe("browser-bound local sign-in", () => {
	it("requires the initiating cookie and origin, persists first, restores a new session, then logs out", async () => {
		let f = await fixture();
		let { router, auth } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		expect(await started.clone().text()).not.toContain("private-");
		expect(await started.json()).toMatchObject({
			status: "waiting",
			userCode: "E2E1-0001",
			verificationUri: "https://github.com/login/device",
		});
		expect(cookies(started)[0]).toContain("HttpOnly");
		let stolen = await f.request(router, "/auth/device/complete", "POST");
		expect(await stolen.json()).toEqual({ status: "cancelled" });
		let forbidden = await f.request(
			router,
			"/auth/device/complete",
			"POST",
			attempt,
			"http://attacker.invalid",
		);
		expect(forbidden.status).toBe(403);
		expect(await f.request(router, "/auth/github")).toMatchObject({ status: 404 });
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, attempt);
		let completed = await f.request(router, "/auth/device/complete", "POST", attempt);
		expect(await completed.json()).toEqual({ status: "complete" });
		let issued = cookies(completed);
		expect(issued.join(" ")).not.toContain("ghu_local_private");
		let binding = pair(issued.find(value => value.startsWith("chopin_local_binding_8790="))!);
		let session = pair(issued.find(value => value.startsWith("chopin_session_8790="))!);
		expect(f.values.size).toBe(1);
		expect(await readdir(f.root)).toEqual([]);
		let first = await f.request(router, "/api/session", "GET", session);
		expect(await first.clone().text()).not.toMatch(/gh[ur]_[A-Za-z0-9_-]+/);
		expect(await first.json()).toMatchObject({ auth: "local", user: { id: "U_one" } });
		let id = (await auth.sessions.authenticate(
			new Request(f.config.origin, {
				headers: { cookie: session },
			}),
		))!.session.id;
		expect(JSON.stringify(await f.storage.sessions.get(id, new Date())))
			.not.toMatch(/gh[ur]_[A-Za-z0-9_-]+/);
		f.advance(28_800_000 - 4 * 60_000);
		let concurrent = await Promise.all([
			f.request(router, "/api/session", "GET", session),
			f.request(router, "/api/session", "GET", session),
		]);
		expect(concurrent.map(value => value.status)).toEqual([200, 200]);
		expect(f.refreshes()).toBe(1);
		expect(JSON.parse([...f.values.values()][0]!)).toMatchObject({
			accessToken: "ghu_rotated",
			refreshToken: "ghr_rotated",
			generation: 2,
		});
		let { router: restarted, auth: newAuth } = f.server();
		let stranger = await f.request(restarted, "/api/session");
		expect(await stranger.json()).toMatchObject({ auth: "local", user: null });
		let restored = await f.request(restarted, "/api/session", "GET", binding);
		expect(await restored.json()).toMatchObject({ user: { id: "U_one" } });
		let restoredSession = pair(cookies(restored)[0]!);
		let restoredId = (await newAuth.sessions.authenticate(
			new Request(f.config.origin, {
				headers: { cookie: restoredSession },
			}),
		))!.session.id;
		expect(restoredId).not.toBe(id);
		let loggedOut = await f.request(
			restarted,
			"/auth/logout",
			"POST",
			`${binding}; ${restoredSession}`,
		);
		expect(loggedOut.status).toBe(204);
		expect(f.values.size).toBe(0);
		expect((await f.request(restarted, "/api/session", "GET", binding)).status).toBe(200);
		expect(await (await f.request(restarted, "/api/session", "GET", binding)).json())
			.toMatchObject({ user: null });
	});

	it("decline preserves the old account; a new attempt can consent to plaintext", async () => {
		let f = await fixture(true);
		let { router } = f.server();
		let start = async () => pair(cookies(await f.request(router, "/auth/device", "POST"))[0]!);
		let first = await start();
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, first);
		let prompt = await f.request(router, "/auth/device/complete", "POST", first);
		let consent = await prompt.json();
		expect(consent).toMatchObject({ status: "consent" });
		expect(consent.path).toContain(f.root);
		expect(await readdir(f.root)).toEqual([]);
		let declined = await f.request(router, "/auth/device/consent", "POST", first, f.config.origin, {
			accept: false,
		});
		expect(await declined.json()).toEqual({ status: "cancelled" });
		expect(await (await f.request(router, "/api/session")).json()).toMatchObject({ user: null });
		let next = await start();
		f.waits.shift()!.release();
		await f.wait("authorized", router, next);
		await f.request(router, "/auth/device/complete", "POST", next);
		let accepted = await f.request(router, "/auth/device/consent", "POST", next, f.config.origin, {
			accept: true,
		});
		expect(await accepted.json()).toEqual({ status: "complete" });
		let binding = pair(cookies(accepted).find(value => value.startsWith("chopin_local_binding"))!);
		expect((await stat(join(f.root, "config"))).mode & 0o777).toBe(0o700);
		let files = await readdir(join(f.root, "config"));
		expect(files).toHaveLength(1);
		expect((await stat(join(f.root, "config", files[0]!))).mode & 0o777).toBe(0o600);
		let restarted = f.server();
		expect(await (await f.request(restarted.router, "/api/session", "GET", binding)).json())
			.toMatchObject({ user: { id: "U_one" } });
	});

	it("honors repeated slow_down, provider denial, cancellation and a fresh retry code", async () => {
		let f = await fixture();
		let { router } = f.server();
		f.outcomes.push({ error: "slow_down" }, { error: "slow_down", interval: 18 }, {
			error: "authorization_pending",
		}, { error: "access_denied" });
		let first = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(first)[0]!);
		for (let index = 0; index < 4; index++) {
			let queued = f.waits.shift()!;
			queued.release();
			if (index < 3) {
				for (let n = 0; n < 100 && !f.waits.length; n++) await Bun.sleep(1);
			}
		}
		await f.wait("denied", router, attempt);
		expect(f.intervals.slice(0, 4)).toEqual([1_000, 6_000, 18_000, 18_000]);
		let second = await f.request(router, "/auth/device", "POST", attempt);
		let newAttempt = pair(cookies(second)[0]!);
		expect(newAttempt).not.toBe(attempt);
		expect(await (await f.request(router, "/auth/device", "GET", attempt)).json())
			.toMatchObject({ status: "cancelled" });
		await f.request(router, "/auth/device/cancel", "POST", newAttempt);
		f.waits.shift()?.release();
		expect(await (await f.request(router, "/auth/device", "GET", newAttempt)).json())
			.toMatchObject({ status: "cancelled" });
		expect(f.values.size).toBe(0);
	});

	it("expires locally without an approval and ignores a late response after cancellation", async () => {
		let f = await fixture();
		let { router } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.advance(901_000);
		f.waits.shift()!.release();
		await f.wait("expired", router, attempt);
		expect(f.polls).toHaveLength(0);
		let retry = await f.request(router, "/auth/device", "POST", attempt);
		let next = pair(cookies(retry)[0]!);
		await f.request(router, "/auth/device/cancel", "POST", next);
		f.approve();
		f.waits.shift()?.release();
		expect(await (await f.request(router, "/auth/device/complete", "POST", next)).json())
			.toMatchObject({ status: "cancelled" });
		expect(f.values.size).toBe(0);
	});

	it("does not issue a restored session when logout races identity revalidation", async () => {
		let f = await fixture();
		let first = f.server();
		let started = await f.request(first.router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", first.router, attempt);
		let completed = await f.request(first.router, "/auth/device/complete", "POST", attempt);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		let restarted = f.server();
		let gate = f.pauseUser();
		let restoring = f.request(restarted.router, "/api/session", "GET", binding);
		await gate.started;
		let logout = await f.request(restarted.router, "/auth/logout", "POST", binding);
		expect(logout.status).toBe(204);
		gate.release();
		let response = await restoring;
		expect(await response.json()).toMatchObject({ user: null });
		expect(f.values.size).toBe(0);
	});

	it("declining a replacement leaves the active binding untouched; success removes the old one", async () => {
		let f = await fixture();
		let { router, auth } = f.server();
		let start = async (cookie = "") => {
			let result = await f.request(router, "/auth/device", "POST", cookie);
			let attempt = pair(cookies(result)[0]!);
			f.approve();
			f.waits.shift()!.release();
			await f.wait("authorized", router, attempt);
			return attempt;
		};
		let first = await start();
		let completed = await f.request(router, "/auth/device/complete", "POST", first);
		let original = cookies(completed);
		let oldBinding = pair(original.find(value => value.startsWith("chopin_local_binding"))!);
		let oldSession = pair(original.find(value => value.startsWith("chopin_session"))!);
		expect(f.values.size).toBe(1);
		f.setVaultFailure(true);
		let second = await start(`${oldBinding}; ${oldSession}`);
		let mixed = `${second}; ${oldBinding}; ${oldSession}`;
		let warning = await f.request(router, "/auth/device/complete", "POST", mixed);
		expect(await warning.json()).toMatchObject({ status: "consent" });
		await f.request(router, "/auth/device/consent", "POST", mixed, f.config.origin, {
			accept: false,
		});
		expect(
			(await auth.sessions.authenticate(
				new Request(f.config.origin, {
					headers: { cookie: oldSession },
				}),
			))?.user.id,
		).toBe("U_one");
		expect(f.values.size).toBe(1);
		f.setVaultFailure(false);
		let third = await start(`${oldBinding}; ${oldSession}`);
		let replaced = await f.request(
			router,
			"/auth/device/complete",
			"POST",
			`${third}; ${oldBinding}; ${oldSession}`,
		);
		expect(await replaced.json()).toEqual({ status: "complete" });
		expect(
			await auth.sessions.authenticate(
				new Request(f.config.origin, {
					headers: { cookie: oldSession },
				}),
			),
		).toBeUndefined();
		expect(f.values.size).toBe(1);
	});

	it("uses five, ten, fifteen seconds across slow_down and honors a larger reply", async () => {
		let f = await fixture(false, 5);
		let { router } = f.server();
		f.outcomes.push(
			{ error: "slow_down" },
			{ error: "slow_down" },
			{ error: "slow_down", interval: 22 },
			{ error: "access_denied" },
		);
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		for (let index = 0; index < 4; index++) {
			f.waits.shift()!.release();
			if (index < 3) { for (let n = 0; n < 100 && !f.waits.length; n++) await Bun.sleep(1); }
		}
		await f.wait("denied", router, attempt);
		expect(f.intervals.slice(0, 4)).toEqual([5_000, 10_000, 15_000, 22_000]);
	});

	it("abandons an unanswered plaintext prompt and refuses persistence after expiry", async () => {
		let f = await fixture(true);
		let { router } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, attempt);
		let warning = await f.request(router, "/auth/device/complete", "POST", attempt);
		expect(await warning.json()).toMatchObject({ status: "consent" });
		f.advance(11 * 60_000);
		expect(await (await f.request(router, "/auth/device", "GET", attempt)).json())
			.toMatchObject({ status: "cancelled" });
		expect(
			await (await f.request(router, "/auth/device/consent", "POST", attempt, f.config.origin, {
				accept: true,
			})).json(),
		).toMatchObject({ status: "cancelled" });
		expect(await readdir(f.root)).toEqual([]);
	});

	it("rejects account substitution on restore and discards a failed plaintext write", async () => {
		let f = await fixture();
		let { router } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, attempt);
		let completed = await f.request(router, "/auth/device/complete", "POST", attempt);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		f.setUserId("U_other");
		let restarted = f.server();
		expect(await (await f.request(restarted.router, "/api/session", "GET", binding)).json())
			.toMatchObject({ user: null });
		expect(f.values.size).toBe(0);
		let unavailable = await fixture(true);
		let service = unavailable.server();
		let next = await unavailable.request(service.router, "/auth/device", "POST");
		let cookie = pair(cookies(next)[0]!);
		unavailable.approve();
		unavailable.waits.shift()!.release();
		await unavailable.wait("authorized", service.router, cookie);
		await unavailable.request(service.router, "/auth/device/complete", "POST", cookie);
		unavailable.credentials.save = async () => {
			throw new Error("disk full");
		};
		let failure = await unavailable.request(
			service.router,
			"/auth/device/consent",
			"POST",
			cookie,
			unavailable.config.origin,
			{ accept: true },
		);
		expect(await failure.json()).toMatchObject({ status: "failed" });
		expect(await (await unavailable.request(service.router, "/api/session")).json())
			.toMatchObject({ user: null });
		expect(await readdir(unavailable.root)).toEqual([]);
	});

	it("sets Secure on local attempt and binding cookies for an HTTPS loopback origin", async () => {
		let f = await fixture();
		f.config.origin = "https://localhost:8790";
		let { router } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		expect(cookies(started)[0]).toContain("Secure");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, attempt);
		let completed = await f.request(router, "/auth/device/complete", "POST", attempt);
		expect(cookies(completed).find(value => value.startsWith("chopin_local_binding")))
			.toContain("Secure");
		expect(cookies(completed).find(value => value.startsWith("__Host-chopin_session")))
			.toContain("Secure");
	});

	it("revokes on a failed durable rotation instead of using memory or plaintext", async () => {
		let f = await fixture();
		let { router } = f.server();
		let started = await f.request(router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", router, attempt);
		let completed = await f.request(router, "/auth/device/complete", "POST", attempt);
		let session = pair(cookies(completed).find(value => value.startsWith("chopin_session"))!);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		f.advance(28_800_000 - 4 * 60_000);
		f.setVaultFailure(true);
		let response = await f.request(router, "/api/session", "GET", `${session}; ${binding}`);
		expect(await response.json()).toMatchObject({ user: null });
		expect(f.refreshes()).toBe(1);
		expect(f.values.size).toBe(0);
		expect(await readdir(f.root)).toEqual([]);
	});

	it("never shares a restore flight with the same binding ID but a wrong secret", async () => {
		let f = await fixture();
		let first = f.server();
		let started = await f.request(first.router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", first.router, attempt);
		let completed = await f.request(first.router, "/auth/device/complete", "POST", attempt);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		let [name, value] = binding.split("=");
		let id = value!.split(".")[0]!;
		let forged = `${name}=${id}.${Buffer.alloc(32, 9).toString("base64url")}`;
		let restarted = f.server();
		let gate = f.pauseUser();
		let valid = f.request(restarted.router, "/api/session", "GET", binding);
		await gate.started;
		let invalid = f.request(restarted.router, "/api/session", "GET", forged);
		gate.release();
		expect(await (await invalid).json()).toMatchObject({ user: null });
		expect(await (await valid).json()).toMatchObject({ user: { id: "U_one" } });
	});

	it("returns to sign-in after an interrupted rotation leaves a spent refresh token", async () => {
		let f = await fixture();
		let first = f.server();
		let started = await f.request(first.router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", first.router, attempt);
		let completed = await f.request(first.router, "/auth/device/complete", "POST", attempt);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		f.advance(28_800_000 + 1_000);
		f.rejectRefresh();
		let restarted = f.server();
		let restored = await f.request(restarted.router, "/api/session", "GET", binding);
		expect(await restored.json()).toMatchObject({ user: null });
		expect(f.refreshes()).toBe(1);
		expect(f.values.size).toBe(0);
		expect(await (await f.request(restarted.router, "/api/session", "GET", binding)).json())
			.toMatchObject({ user: null });
	});

	it("returns to sign-in without resending a spent token when restore rotation cannot be persisted", async () => {
		let f = await fixture();
		let first = f.server();
		let started = await f.request(first.router, "/auth/device", "POST");
		let attempt = pair(cookies(started)[0]!);
		f.approve();
		f.waits.shift()!.release();
		await f.wait("authorized", first.router, attempt);
		let completed = await f.request(first.router, "/auth/device/complete", "POST", attempt);
		let binding = pair(cookies(completed).find(value => value.startsWith("chopin_local_binding"))!);
		f.advance(28_800_000 - 4 * 60_000);
		let originalSave = f.credentials.save;
		f.credentials.save = async () => {
			throw new Error("disk full");
		};
		let restarted = f.server();
		let restored = await f.request(restarted.router, "/api/session", "GET", binding);
		expect(restored.status).toBe(200);
		expect(await restored.json()).toMatchObject({ user: null });
		expect(cookies(restored).find(value => value.startsWith("chopin_local_binding")))
			.toContain("Max-Age=0");
		expect(f.refreshes()).toBe(1);
		expect(f.values.size).toBe(0);
		f.credentials.save = originalSave;
		let again = f.server();
		let second = await f.request(again.router, "/api/session", "GET", binding);
		expect(await second.json()).toMatchObject({ user: null });
		expect(f.refreshes()).toBe(1);
	});
});
