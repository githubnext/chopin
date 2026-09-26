import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { GitHubError, GitHubTokenError } from "../github/client";
import { AdmissionDenied } from "./admission";
import { DeviceAuthorization } from "./device";
import { credentialGrant, LocalCredentials } from "./local-store";

import type { Admission } from "./admission";
import type { AuthConfig } from "./config";
import type { DeviceCode } from "./device";
import type { GitHub } from "../github/client";
import type { GitHubTokenGrant, GitHubUser } from "../github/client";
import type { LocalCredential } from "./local-store";
import type { Sessions } from "./session";
import type { StorageAdapter } from "../storage/port";

const EXPIRED = "Device code expired before authorization completed";
const CONSENT_MS = 10 * 60_000;
const EARLY_MS = 5 * 60_000;

type Attempt = {
	id: string;
	secretHash: string;
	controller: AbortController;
	status:
		| "waiting"
		| "authorized"
		| "persisting"
		| "consent"
		| "complete"
		| "failed"
		| "expired"
		| "denied"
		| "cancelled";
	code: DeviceCode;
	expiresAt: number;
	grant?: GitHubTokenGrant;
	profile?: GitHubUser;
	grantReceivedAt?: number;
	message?: string;
	path?: string;
	binding?: { id: string; secret: string };
	completing?: Promise<{ status: string; path?: string; cookies?: string[] }>;
};

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function secret(): string {
	return randomBytes(32).toString("base64url");
}

function cookieValue(request: Request, name: string): string | undefined {
	let pairs = request.headers.get("cookie")?.split(";").map(value => value.trim()) ?? [];
	let found = pairs.filter(value => value.startsWith(`${name}=`));
	return found.length === 1 ? found[0]!.slice(name.length + 1) : undefined;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
	return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
		Math.max(0, Math.floor(maxAge))
	}${secure ? "; Secure" : ""}`;
}

function identity(value: string | undefined): { id: string; secret: string } | undefined {
	if (!value) return undefined;
	let match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
	return match ? { id: match[1]!, secret: match[2]! } : undefined;
}

function same(left: string, right: string): boolean {
	let a = Buffer.from(left, "hex");
	let b = Buffer.from(right, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

export class LocalAuth {
	readonly #config: AuthConfig;
	readonly #storage: StorageAdapter;
	readonly #sessions: Sessions;
	readonly #admission: Admission;
	readonly #github: GitHub;
	readonly #device: DeviceAuthorization;
	readonly #credentials: LocalCredentials;
	readonly #clock: () => number;
	readonly #secure: boolean;
	readonly #scheduledDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #attempts = new Map<string, Attempt>();
	readonly #bindings = new Map<
		string,
		{ sessionId: string; sessionCookie: string; record: LocalCredential }
	>();
	readonly #sessionBindings = new Map<string, string>();
	readonly #restores = new Map<
		string,
		Promise<{ cookie?: string; authenticated?: boolean; clear?: boolean }>
	>();
	readonly #revoked = new Set<string>();
	readonly attemptCookie: string;
	readonly bindingCookie: string;

	constructor(input: {
		config: AuthConfig;
		storage: StorageAdapter;
		sessions: Sessions;
		admission: Admission;
		github: GitHub;
		device?: DeviceAuthorization;
		credentials?: LocalCredentials;
		clock?: () => number;
		delay?: (ms: number, signal: AbortSignal) => Promise<void>;
	}) {
		this.#config = input.config;
		this.#storage = input.storage;
		this.#sessions = input.sessions;
		this.#admission = input.admission;
		this.#github = input.github;
		this.#device = input.device ?? new DeviceAuthorization();
		this.#credentials = input.credentials
			?? new LocalCredentials(input.config.local!.credentialsDir);
		this.#clock = input.clock ?? Date.now;
		this.#secure = new URL(input.config.origin).protocol === "https:";
		this.#scheduledDelay = input.delay;
		this.attemptCookie = `chopin_local_attempt_${input.config.local!.port}`;
		this.bindingCookie = `chopin_local_binding_${input.config.local!.port}`;
	}

	get clearAttempt(): string {
		return cookie(this.attemptCookie, "", 0, this.#secure);
	}
	get clearBinding(): string {
		return cookie(this.bindingCookie, "", 0, this.#secure);
	}

	#bound(request: Request): Attempt | undefined {
		let parsed = identity(cookieValue(request, this.attemptCookie));
		let attempt = parsed && this.#attempts.get(parsed.id);
		return attempt && same(attempt.secretHash, digest(parsed!.secret)) ? attempt : undefined;
	}

	#binding(request: Request): { id: string; secret: string } | undefined {
		return identity(cookieValue(request, this.bindingCookie));
	}

	#scope(bindingId: string) {
		return {
			installation: this.#config.local!.installation,
			origin: this.#config.origin,
			clientId: this.#config.clientId,
			bindingId,
		};
	}

	#record(attempt: Attempt, backend: LocalCredential["backend"]): LocalCredential {
		let binding = attempt.binding!;
		let now = attempt.grantReceivedAt!;
		return {
			v: 1,
			...this.#scope(binding.id),
			accountId: attempt.profile!.id,
			login: attempt.profile!.login,
			bindingSecretHash: digest(binding.secret),
			accessToken: attempt.grant!.accessToken,
			accessExpiresAt: now + attempt.grant!.accessExpiresIn * 1_000,
			refreshToken: attempt.grant!.refreshToken,
			refreshExpiresAt: now + attempt.grant!.refreshExpiresIn * 1_000,
			backend,
			generation: 1,
		};
	}

	#safe(attempt: Attempt) {
		return {
			status: attempt.status,
			...(attempt.status === "waiting"
				? {
					userCode: attempt.code.userCode,
					verificationUri: attempt.code.verificationUri,
					expiresAt: new Date(attempt.expiresAt).toISOString(),
				}
				: {}),
			...(attempt.status === "consent" ? { path: attempt.path } : {}),
			...(attempt.status === "failed" ? { message: attempt.message } : {}),
		};
	}

	async start(request: Request) {
		for (let [id, attempt] of this.#attempts) {
			if (this.#clock() >= attempt.expiresAt && attempt.status !== "persisting") {
				attempt.controller.abort();
				attempt.grant = undefined;
				this.#attempts.delete(id);
			}
		}
		let previous = this.#bound(request);
		if (previous) this.cancel(request);
		let controller = new AbortController();
		let code = await this.#device.request(
			this.#config.clientId,
			AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
		);
		let id = crypto.randomUUID();
		let key = secret();
		let attempt: Attempt = {
			id,
			secretHash: digest(key),
			controller,
			status: "waiting",
			code,
			expiresAt: this.#clock() + code.expiresIn * 1_000,
		};
		this.#attempts.set(id, attempt);
		void this.#poll(attempt).catch(() => {});
		return {
			body: this.#safe(attempt),
			cookie: cookie(this.attemptCookie, `${id}.${key}`, code.expiresIn, this.#secure),
		};
	}

	status(request: Request) {
		let attempt = this.#bound(request);
		if (!attempt) return undefined;
		if (attempt.status === "waiting" && this.#clock() >= attempt.expiresAt) {
			attempt.status = "expired";
			attempt.controller.abort();
		}
		if (attempt.status === "consent" && this.#clock() >= attempt.expiresAt) {
			attempt.status = "cancelled";
			attempt.grant = undefined;
		}
		return this.#safe(attempt);
	}

	cancel(request: Request): { status: "cancelled" } {
		let attempt = this.#bound(request);
		if (attempt && attempt.status !== "complete") {
			attempt.controller.abort();
			attempt.status = "cancelled";
			attempt.grant = undefined;
			attempt.profile = undefined;
			if (attempt.binding) {
				this.#revoked.add(attempt.binding.id);
				void this.#credentials.delete(this.#scope(attempt.binding.id)).catch(() => {});
			}
		}
		return { status: "cancelled" };
	}

	async #delay(ms: number, signal: AbortSignal) {
		await new Promise<void>(resolve => {
			let timeout = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, ms);
			let abort = () => {
				clearTimeout(timeout);
				resolve();
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	async #poll(attempt: Attempt) {
		let interval = attempt.code.interval * 1_000;
		let retry = 0;
		while (attempt.status === "waiting" && !attempt.controller.signal.aborted) {
			let remaining = attempt.expiresAt - this.#clock();
			if (remaining <= 0) break;
			await (this.#scheduledDelay ?? ((ms, signal) => this.#delay(ms, signal)))(
				Math.min(remaining, Math.max(interval, retry)),
				attempt.controller.signal,
			);
			if (attempt.status !== "waiting" || attempt.controller.signal.aborted) return;
			remaining = attempt.expiresAt - this.#clock();
			if (remaining <= 0) break;
			let answer;
			try {
				answer = await this.#device.poll(
					this.#config.clientId,
					attempt.code.deviceCode,
					AbortSignal.any([
						attempt.controller.signal,
						AbortSignal.timeout(Math.min(15_000, remaining)),
					]),
				);
			} catch {
				if (attempt.controller.signal.aborted) return;
				retry = Math.max(interval, Math.min(Math.max(retry * 2, interval), 60_000));
				continue;
			}
			if (attempt.status !== "waiting" || attempt.controller.signal.aborted) return;
			if (answer.status === "pending") {
				retry = 0;
				continue;
			}
			if (answer.status === "slow_down") {
				interval = Math.max(interval + 5_000, (answer.interval ?? 0) * 1_000);
				retry = 0;
				continue;
			}
			if (answer.status === "transient") {
				retry = Math.max(interval, Math.min(Math.max(retry * 2, interval), 60_000));
				continue;
			}
			if (answer.status === "granted") {
				try {
					let receivedAt = this.#clock();
					let profile = await this.#admission.user(answer.grant.accessToken);
					if (attempt.status !== "waiting" || attempt.controller.signal.aborted) return;
					if (this.#clock() >= attempt.expiresAt) {
						attempt.status = "expired";
						return;
					}
					attempt.profile = profile;
					attempt.grant = answer.grant;
					attempt.grantReceivedAt = receivedAt;
					attempt.status = "authorized";
					attempt.expiresAt = Math.min(attempt.expiresAt, this.#clock() + CONSENT_MS);
				} catch (err) {
					if (attempt.status !== "waiting" || attempt.controller.signal.aborted) return;
					attempt.status = "failed";
					attempt.message = err instanceof AdmissionDenied
						? err.message
						: "GitHub identity is unavailable";
				}
				return;
			}
			attempt.status = answer.status === "denied"
				? "denied"
				: answer.status === "expired"
				? "expired"
				: "failed";
			if (answer.status === "failed") attempt.message = answer.message;
			return;
		}
		if (attempt.status === "waiting" && !attempt.controller.signal.aborted) {
			attempt.status = "expired";
			attempt.message = EXPIRED;
		}
	}

	async complete(request: Request, accept?: boolean) {
		let attempt = this.#bound(request);
		if (!attempt) return undefined;
		if (accept === false) return this.cancel(request);
		if (attempt.completing) return attempt.completing;
		if (attempt.status !== "authorized" && !(accept && attempt.status === "consent")) {
			return this.#safe(attempt);
		}
		if (this.#clock() >= attempt.expiresAt) {
			this.cancel(request);
			return { status: "expired" };
		}
		let original = attempt.status;
		attempt.status = "persisting";
		let action = (async () => {
			attempt.binding ??= { id: crypto.randomUUID(), secret: secret() };
			let record = this.#record(attempt, original === "consent" ? "plaintext" : "keychain");
			try {
				if (original === "authorized") {
					let saved = await this.#credentials.saveSecure(record);
					if (attempt.status === "cancelled") return { status: "cancelled" };
					if (!saved) {
						attempt.status = "consent";
						attempt.path = this.#credentials.path(record);
						return { status: "consent", path: attempt.path };
					}
				} else await this.#credentials.save({ ...record, backend: "plaintext" });
				if (attempt.status === "cancelled" || this.#revoked.has(record.bindingId)) {
					await this.#credentials.delete(record);
					return { status: "cancelled" };
				}
				if (original === "consent") record.backend = "plaintext";
				await this.#storage.users.put({ ...attempt.profile!, now: new Date(this.#clock()) });
				let issued = await this.#sessions.issue(
					record.accountId,
					credentialGrant(record, this.#clock()),
				);
				this.#bindings.set(record.bindingId, {
					sessionId: issued.id,
					sessionCookie: issued.cookie,
					record,
				});
				this.#sessionBindings.set(issued.id, record.bindingId);
				attempt.status = "complete";
				attempt.grant = undefined;
				let old = this.#binding(request);
				if (old && old.id !== record.bindingId) {
					this.#revoked.add(old.id);
					let previous = this.#bindings.get(old.id);
					if (previous) {
						await this.#sessions.revoke(
							new Request(this.#config.origin, {
								headers: { cookie: previous.sessionCookie.split(";", 1)[0]! },
							}),
						).catch(() => {});
					}
					await this.#credentials.delete(this.#scope(old.id)).catch(() => {});
				}
				return {
					status: "complete",
					cookies: [
						issued.cookie,
						cookie(
							this.bindingCookie,
							`${record.bindingId}.${attempt.binding.secret}`,
							(record.refreshExpiresAt - this.#clock()) / 1_000,
							this.#secure,
						),
						this.clearAttempt,
					],
				};
			} catch {
				attempt.status = "failed";
				attempt.message = "Could not save credentials";
				await this.#credentials.delete(record).catch(() => {});
				return { status: "failed", message: attempt.message };
			}
		})();
		attempt.completing = action;
		try {
			return await action;
		} finally {
			attempt.completing = undefined;
		}
	}

	async persist(sessionId: string, grant: GitHubTokenGrant, revision: number): Promise<void> {
		let bindingId = this.#sessionBindings.get(sessionId);
		let binding = bindingId && this.#bindings.get(bindingId);
		if (!binding || binding.sessionId !== sessionId || this.#revoked.has(bindingId!)) {
			throw new Error("local binding was revoked");
		}
		let now = this.#clock();
		let next: LocalCredential = {
			...binding.record,
			accessToken: grant.accessToken,
			accessExpiresAt: now + grant.accessExpiresIn * 1_000,
			refreshToken: grant.refreshToken,
			refreshExpiresAt: now + grant.refreshExpiresIn * 1_000,
			generation: revision,
		};
		await this.#credentials.save(next);
		if (this.#revoked.has(bindingId!) || this.#bindings.get(bindingId!) !== binding) {
			await this.#credentials.delete(next);
			throw new Error("local binding was revoked");
		}
		binding.record = next;
	}

	async revoked(sessionId: string): Promise<void> {
		let id = this.#sessionBindings.get(sessionId);
		if (!id) return;
		this.#sessionBindings.delete(sessionId);
		let binding = this.#bindings.get(id);
		if (binding?.sessionId !== sessionId) return;
		this.#bindings.delete(id);
		this.#revoked.add(id);
		await this.#credentials.delete(this.#scope(id)).catch(() => {});
	}

	async logout(request: Request): Promise<void> {
		let binding = this.#binding(request);
		if (!binding) return;
		this.#revoked.add(binding.id);
		let current = this.#bindings.get(binding.id);
		let record = current?.record
			?? await this.#credentials.read(this.#scope(binding.id)).catch(() => undefined);
		if (!record || !same(record.bindingSecretHash, digest(binding.secret))) return;
		await this.#credentials.delete(record);
		this.#bindings.delete(binding.id);
	}

	async restore(
		request: Request,
	): Promise<{ cookie?: string; authenticated?: boolean; clear?: boolean }> {
		let binding = this.#binding(request);
		if (!binding || this.#revoked.has(binding.id)) return { clear: !!binding };
		let flight = `${binding.id}:${digest(binding.secret)}`;
		let existing = this.#restores.get(flight);
		if (existing) return existing;
		let task = this.#restore(binding);
		this.#restores.set(flight, task);
		try {
			return await task;
		} finally {
			if (this.#restores.get(flight) === task) this.#restores.delete(flight);
		}
	}
	async #restore(binding: { id: string; secret: string }) {
		let scope = this.#scope(binding.id);
		let record = await this.#credentials.read(scope);
		if (!record || !same(record.bindingSecretHash, digest(binding.secret))) return { clear: true };
		if (this.#revoked.has(binding.id)) return { clear: true };
		let previous = this.#bindings.get(binding.id);
		if (previous && !this.#revoked.has(binding.id)) {
			// Concurrent tabs share one browser-bound session cookie instead of refreshing twice.
			return { cookie: previous.sessionCookie, authenticated: true };
		}
		if (record.refreshExpiresAt <= this.#clock()) {
			await this.#credentials.delete(record);
			return { clear: true };
		}
		try {
			if (record.accessExpiresAt <= this.#clock() + EARLY_MS) {
				let grant = await this.#github.refresh({
					clientId: this.#config.clientId,
					refreshToken: record.refreshToken,
				});
				if (this.#revoked.has(binding.id)) return { clear: true };
				let now = this.#clock();
				record = {
					...record,
					accessToken: grant.accessToken,
					accessExpiresAt: now + grant.accessExpiresIn * 1_000,
					refreshToken: grant.refreshToken,
					refreshExpiresAt: now + grant.refreshExpiresIn * 1_000,
					generation: record.generation + 1,
				};
				try {
					await this.#credentials.save(record);
				} catch {
					this.#revoked.add(binding.id);
					await this.#credentials.delete(record).catch(() => {});
					return { clear: true };
				}
				if (this.#revoked.has(binding.id)) {
					await this.#credentials.delete(record);
					return { clear: true };
				}
			}
			let user = await this.#admission.user(record.accessToken);
			if (user.id !== record.accountId || user.login !== record.login) {
				await this.#credentials.delete(record);
				return { clear: true };
			}
			if (this.#revoked.has(binding.id)) return { clear: true };
			await this.#storage.users.put({ ...user, now: new Date(this.#clock()) });
			let issued = await this.#sessions.issue(user.id, credentialGrant(record, this.#clock()));
			if (this.#revoked.has(binding.id)) {
				await this.#sessions.revoke(
					new Request(this.#config.origin, {
						headers: {
							cookie: issued.cookie.split(";", 1)[0]!,
						},
					}),
				);
				return { clear: true };
			}
			this.#bindings.set(binding.id, {
				sessionId: issued.id,
				sessionCookie: issued.cookie,
				record,
			});
			this.#sessionBindings.set(issued.id, binding.id);
			return { cookie: issued.cookie, authenticated: true };
		} catch (err) {
			if (
				err instanceof GitHubTokenError && err.terminal
				|| err instanceof GitHubError && err.status === 401 || err instanceof AdmissionDenied
			) {
				await this.#credentials.delete(record);
				this.#revoked.add(binding.id);
				return { clear: true };
			}
			throw err;
		}
	}
}
