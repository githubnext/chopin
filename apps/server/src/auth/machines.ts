import { createHash, hkdfSync, randomBytes } from "node:crypto";

import { GitHubError, GitHubTokenError } from "../github/client";
import { decrypted, encrypted, imported } from "./session";

import type { GitHubTokenGrant } from "../github/client";
import type { MachineCredentials, MachineRepository, StoredMachine } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

const MACHINE_CONTEXT = "chopin:machine-credential:v1";
const REFRESH_EARLY_MS = 5 * 60 * 1_000;
/** Contact is recorded at most this often, so a polling connector does not write on every call. */
const SEEN_MS = 60_000;
const TOKEN_PREFIX = "chopin_m_";
const TOKEN = /^chopin_m_[A-Za-z0-9_-]{43}$/;

type Clock = () => Date;

/** Machine refusals the connector must stop on rather than retry. */
export class MachineError extends Error {
	constructor(readonly code: "machine-revoked" | "machine-reauthorize") {
		super(code);
		this.name = "MachineError";
	}
}

type Grant = {
	accessToken: string;
	accessExpiresAt: number;
	refreshToken: string;
	refreshExpiresAt: number;
	revision: number;
};

type Options = {
	/** The deployment's SESSION_ENCRYPTION_KEY; without it machines hold no GitHub credentials. */
	key?: Uint8Array;
	origin: string;
	clientId: string;
	refresh?: (refreshToken: string) => Promise<GitHubTokenGrant>;
	/** Whether the owner is still admitted, as a browser session is rechecked. */
	authorize?: (userId: string, accessToken: string) => Promise<boolean>;
	invalidate?: (accessToken: string) => void;
};

export type PairMachine = {
	userId: string;
	label: string;
	repositories: MachineRepository[];
	autoRun: boolean;
	/** The machine's own GitHub authorization; GitHub refresh tokens are single-use, never shared. */
	grant?: GitHubTokenGrant;
};

function digest(token: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(token).digest());
}

/**
 * Durable machine credentials: a bearer token stored only as a hash, and the owner's GitHub App
 * user token pair for that machine, encrypted like hosted browser sessions under a separate key.
 */
export class Machines {
	readonly #storage: StorageAdapter;
	readonly #clock: Clock;
	readonly #options: Options;
	readonly #key: Promise<CryptoKey> | undefined;
	readonly #grants = new Map<string, Grant>();
	readonly #refreshes = new Map<string, Promise<Grant>>();
	readonly #seen = new Map<string, number>();

	constructor(storage: StorageAdapter, clock: Clock, options: Options) {
		this.#storage = storage;
		this.#clock = clock;
		this.#options = options;
		this.#key = options.key
			? imported(new Uint8Array(hkdfSync("sha256", options.key, "", MACHINE_CONTEXT, 32)))
			: undefined;
	}

	/** Machines hold their own GitHub credentials; otherwise they borrow the owner's live login. */
	get durable(): boolean {
		return !!this.#key;
	}

	async pair(input: PairMachine): Promise<{ machine: StoredMachine; token: string }> {
		let token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
		let now = this.#clock();
		let machine: StoredMachine = {
			id: crypto.randomUUID(),
			userId: input.userId,
			label: input.label,
			repositories: input.repositories,
			autoRun: input.autoRun,
			tokenHash: digest(token),
			createdAt: now,
			lastSeenAt: now,
		};
		let grant: Grant | undefined;
		if (input.grant && this.#key) {
			grant = this.#fromGrant(input.grant, 1);
			machine.credentials = await this.#encrypt(machine, grant);
		}
		await this.#storage.machines.create(machine);
		if (grant) this.#grants.set(machine.id, grant);
		return { machine, token };
	}

	/** The live machine a bearer token names. */
	async authenticate(token: string): Promise<StoredMachine> {
		let machine = TOKEN.test(token)
			? await this.#storage.machines.byToken(digest(token))
			: undefined;
		return this.#live(machine);
	}

	/** Reload a machine by id, refusing it once revoked or awaiting re-authorization. */
	async current(id: string): Promise<StoredMachine> {
		return this.#live(await this.#storage.machines.get(id));
	}

	#live(machine: StoredMachine | undefined): StoredMachine {
		if (!machine || machine.revokedAt) throw new MachineError("machine-revoked");
		if (machine.reauthorizeAt) throw new MachineError("machine-reauthorize");
		return machine;
	}

	/** Record contact, at most once a minute per machine. */
	async seen(machine: StoredMachine): Promise<void> {
		let now = this.#clock().getTime();
		if (now - (this.#seen.get(machine.id) ?? 0) < SEEN_MS) return;
		this.#seen.set(machine.id, now);
		await this.#storage.machines.seen(machine.id, new Date(now));
	}

	list(userId: string): Promise<StoredMachine[]> {
		return this.#storage.machines.list(userId);
	}

	async revoke(id: string, userId: string): Promise<boolean> {
		let revoked = await this.#storage.machines.revoke(id, userId, this.#clock());
		if (revoked) this.#forget(id);
		return revoked;
	}

	/**
	 * Run one idempotent GitHub read with the machine's own token, refreshing it when it is about
	 * to expire and once after a 401. GitHub refusing the authorization marks the machine for
	 * re-authorization; an owner no longer admitted loses the machine.
	 */
	async use<T>(machine: StoredMachine, operation: (token: string) => Promise<T>): Promise<T> {
		let grant = await this.#grant(machine);
		if (grant.accessExpiresAt <= this.#clock().getTime() + REFRESH_EARLY_MS) {
			grant = await this.#rotate(machine, grant);
		}
		await this.#admitted(machine, grant);
		try {
			return await operation(grant.accessToken);
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
		}
		let refreshed = await this.#rotate(machine, grant);
		try {
			return await operation(refreshed.accessToken);
		} catch (err) {
			if (!(err instanceof GitHubError) || err.status !== 401) throw err;
			return await this.#reauthorize(machine, refreshed);
		}
	}

	async #admitted(machine: StoredMachine, grant: Grant): Promise<void> {
		if (!this.#options.authorize) return;
		if (await this.#options.authorize(machine.userId, grant.accessToken)) return;
		await this.revoke(machine.id, machine.userId);
		throw new MachineError("machine-revoked");
	}

	async #grant(machine: StoredMachine): Promise<Grant> {
		let cached = this.#grants.get(machine.id);
		if (cached) return cached;
		let stored = await this.current(machine.id);
		if (!stored.credentials || !this.#key) throw new MachineError("machine-reauthorize");
		let value: unknown;
		try {
			value = await decrypted(
				await this.#key,
				this.#aad(stored, stored.credentials.revision),
				stored.credentials.ciphertext,
			);
		} catch {
			throw new MachineError("machine-reauthorize");
		}
		let grant = value as Partial<Grant> | undefined;
		if (
			typeof grant?.accessToken !== "string" || typeof grant.refreshToken !== "string"
			|| typeof grant.accessExpiresAt !== "number" || typeof grant.refreshExpiresAt !== "number"
		) throw new MachineError("machine-reauthorize");
		let restored = { ...grant, revision: stored.credentials.revision } as Grant;
		this.#grants.set(machine.id, restored);
		return restored;
	}

	#rotate(machine: StoredMachine, from: Grant): Promise<Grant> {
		let active = this.#refreshes.get(machine.id);
		if (active) return active;
		let refresh = this.#rotateOnce(machine, from);
		this.#refreshes.set(machine.id, refresh);
		void refresh.finally(() => {
			if (this.#refreshes.get(machine.id) === refresh) this.#refreshes.delete(machine.id);
		}).catch(() => {});
		return refresh;
	}

	async #rotateOnce(machine: StoredMachine, from: Grant): Promise<Grant> {
		let current = this.#grants.get(machine.id);
		// Another call already rotated past the token this one saw.
		if (current && current.revision > from.revision) return current;
		if (!this.#options.refresh || from.refreshExpiresAt <= this.#clock().getTime()) {
			return this.#reauthorize(machine, from);
		}
		let issued: GitHubTokenGrant;
		try {
			issued = await this.#options.refresh(from.refreshToken);
		} catch (err) {
			if (err instanceof GitHubTokenError && err.terminal) return this.#refused(machine, from);
			throw err;
		}
		let next = this.#fromGrant(issued, from.revision + 1);
		let saved = await this.#storage.machines.rotate(
			machine.id,
			from.revision,
			await this.#encrypt(machine, next),
		);
		this.#options.invalidate?.(from.accessToken);
		if (!saved) {
			this.#forget(machine.id);
			await this.current(machine.id);
			throw new MachineError("machine-reauthorize");
		}
		this.#grants.set(machine.id, next);
		return next;
	}

	/**
	 * GitHub refused the refresh token. Another instance may have spent it and saved a newer
	 * revision, which this call then uses; otherwise the machine needs re-authorization, marked only
	 * while the refused revision is still the stored one.
	 */
	async #refused(machine: StoredMachine, from: Grant): Promise<Grant> {
		let newer = await this.#newer(machine, from);
		if (newer) return newer;
		if (!await this.#storage.machines.reauthorize(machine.id, from.revision, this.#clock())) {
			// Rotated between the read and the mark.
			newer = await this.#newer(machine, from);
			if (newer) return newer;
		}
		this.#forget(machine.id);
		throw new MachineError("machine-reauthorize");
	}

	/** The stored credentials, when another instance has rotated past `from`. */
	async #newer(machine: StoredMachine, from: Grant): Promise<Grant | undefined> {
		this.#forget(machine.id);
		let stored = await this.#grant(machine);
		return stored.revision > from.revision ? stored : undefined;
	}

	async #reauthorize(machine: StoredMachine, grant: Grant): Promise<never> {
		await this.#storage.machines.reauthorize(machine.id, grant.revision, this.#clock());
		this.#forget(machine.id);
		throw new MachineError("machine-reauthorize");
	}

	#forget(id: string) {
		let grant = this.#grants.get(id);
		if (grant) this.#options.invalidate?.(grant.accessToken);
		this.#grants.delete(id);
	}

	#fromGrant(grant: GitHubTokenGrant, revision: number): Grant {
		let now = this.#clock().getTime();
		return {
			accessToken: grant.accessToken,
			accessExpiresAt: now + grant.accessExpiresIn * 1_000,
			refreshToken: grant.refreshToken,
			refreshExpiresAt: now + grant.refreshExpiresIn * 1_000,
			revision,
		};
	}

	#aad(machine: StoredMachine, revision: number): string {
		return JSON.stringify([
			MACHINE_CONTEXT,
			this.#options.origin,
			this.#options.clientId,
			machine.id,
			machine.userId,
			Buffer.from(machine.tokenHash).toString("base64url"),
			revision,
		]);
	}

	async #encrypt(machine: StoredMachine, grant: Grant): Promise<MachineCredentials> {
		let { revision, ...payload } = grant;
		return {
			revision,
			ciphertext: await encrypted(await this.#key!, this.#aad(machine, revision), payload),
		};
	}
}
