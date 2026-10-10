import { randomBytes } from "node:crypto";
import type { Source } from "@chopin/experiment";
import { fail, fingerprint } from "./service";

export type PairingInput = Omit<Source, "repositoryId"> & { label: string };
/** One owner's checkout of one repository; it serves every document in that repository. */
export type Connection = {
	id: string;
	owner: string;
	login: string;
	sessionId: string;
	label: string;
	source: Source;
	expiresAt: number;
};
type Pending = {
	id: string;
	input: PairingInput;
	proof: string;
	/** Shown by both the connector and the pairing page so a person can cross-check them. */
	code: string;
	expiresAt: number;
	connection?: Connection;
	token?: string;
};
export type Grant = {
	connectionId: string;
	run?: { id: string; documentId: string; generation: number; kind?: "implementation" | "rebuild" };
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function confirmation() {
	let bytes = randomBytes(8);
	let code = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class Connections {
	#pending = new Map<string, Pending>();
	#connections = new Map<string, Connection>();
	#tokens = new Map<string, Grant>();
	#runTokens = new Map<string, string>();
	#waiters = new Map<string, Set<() => void>>();
	#builds = new Map<string, string>();
	#used = new Map<string, string>();
	#locks = new Map<string, Promise<unknown>>();
	constructor(private now = () => Date.now()) {}
	create(input: PairingInput) {
		this.sweep();
		if (this.#pending.size >= 100) fail("pairing-capacity");
		let secret = randomBytes(32).toString("base64url");
		let id = crypto.randomUUID();
		let code = confirmation();
		this.#pending.set(id, {
			id,
			input,
			proof: fingerprint(secret),
			code,
			expiresAt: this.now() + 300_000,
		});
		return { id, secret, code };
	}
	pending(id: string) {
		let value = this.#pending.get(id);
		if (!value || value.expiresAt <= this.now()) fail("pairing-expired");
		return value;
	}
	approve(
		id: string,
		owner: { id: string; login: string; sessionId: string },
		repositoryId: string,
	) {
		let value = this.pending(id);
		if (value.connection) {
			if (
				value.connection.owner !== owner.id
				|| value.connection.source.repositoryId !== repositoryId
			) fail("already-paired");
			return value.connection;
		}
		if (this.list(repositoryId, owner.id).length >= 8) fail("connection-limit");
		let { label, ...source } = value.input;
		let connection: Connection = {
			id: crypto.randomUUID(),
			owner: owner.id,
			login: owner.login,
			sessionId: owner.sessionId,
			label,
			source: { ...source, repositoryId },
			expiresAt: this.now() + 90_000,
		};
		value.connection = connection;
		value.token = randomBytes(32).toString("base64url");
		this.#connections.set(connection.id, connection);
		this.#tokens.set(fingerprint(value.token), { connectionId: connection.id });
		return connection;
	}
	claim(id: string, secret: string) {
		let value = this.pending(id);
		if (value.proof !== fingerprint(secret)) fail("pairing-forbidden");
		return value.token ? { token: value.token, connection: value.connection } : { waiting: true };
	}
	lookup(token: string) {
		let grant = this.#tokens.get(fingerprint(token));
		let connection = grant && this.get(grant.connectionId);
		if (!grant || !connection) fail("connection-unavailable");
		return { grant, connection };
	}
	get(id: string) {
		let value = this.#connections.get(id);
		return value && value.expiresAt > this.now() ? value : undefined;
	}
	touch(connection: Connection) {
		connection.expiresAt = this.now() + 90_000;
	}
	/** Live connections for a repository, most recently heard from first. */
	list(repositoryId: string, owner?: string) {
		return [...this.#connections.values()].filter(value =>
			value.source.repositoryId === repositoryId && value.expiresAt > this.now()
			&& (owner === undefined || value.owner === owner)
		).sort((a, b) => b.expiresAt - a.expiresAt);
	}
	/** Remember which document holds the build a connection was last given. */
	assign(connectionId: string, documentId: string) {
		if (this.#connections.has(connectionId)) this.#builds.set(connectionId, documentId);
	}
	assigned(connectionId: string) {
		return this.#builds.get(connectionId);
	}
	/** Forget a finished, deleted, or unreachable build so it cannot strand the connection. */
	release(connectionId: string, documentId: string) {
		if (this.#builds.get(connectionId) === documentId) this.#builds.delete(connectionId);
	}
	/** Remember the connection that last ran work for a document, to prefer it next time. */
	use(documentId: string, connectionId: string) {
		this.#used.set(documentId, connectionId);
	}
	/** Live connections for a repository, the one last used for `documentId` first. */
	candidates(repositoryId: string, owner: string, documentId: string) {
		let last = this.#used.get(documentId);
		return this.list(repositoryId, owner).sort((a, b) =>
			Number(b.id === last) - Number(a.id === last)
		);
	}
	runToken(
		connectionId: string,
		documentId: string,
		id: string,
		generation: number,
		kind?: "implementation" | "rebuild",
	) {
		let key = `${connectionId}:${id}:${generation}:${kind ?? "experiment"}`;
		let existing = this.#runTokens.get(key);
		if (existing) return existing;
		let token = randomBytes(32).toString("base64url");
		this.#runTokens.set(key, token);
		this.#tokens.set(fingerprint(token), {
			connectionId,
			run: { id, documentId, generation, ...(kind ? { kind } : {}) },
		});
		return token;
	}
	revoke(id: string) {
		let connection = this.#connections.get(id);
		this.#connections.delete(id);
		this.#builds.delete(id);
		for (let [document, used] of this.#used) if (used === id) this.#used.delete(document);
		for (let key of this.#runTokens.keys()) {
			if (key.startsWith(`${id}:`)) this.#runTokens.delete(key);
		}
		for (let [key, grant] of this.#tokens) if (grant.connectionId === id) this.#tokens.delete(key);
		if (connection) this.wake(connection.source.repositoryId);
	}
	revokeSession(sessionId: string) {
		for (let connection of this.#connections.values()) {
			if (connection.sessionId === sessionId) this.revoke(connection.id);
		}
	}
	sweep() {
		for (let [id, pending] of this.#pending) {
			if (pending.expiresAt <= this.now()) this.#pending.delete(id);
		}
		for (let [id, connection] of this.#connections) {
			if (connection.expiresAt <= this.now()) this.revoke(id);
		}
	}
	/** Wake every connector waiting for work in a repository. */
	wake(repositoryId: string) {
		for (let resolve of this.#waiters.get(repositoryId) ?? []) resolve();
	}
	wait(repositoryId: string, signal: AbortSignal) {
		return new Promise<void>(resolve => {
			let set = this.#waiters.get(repositoryId) ?? new Set();
			this.#waiters.set(repositoryId, set);
			let finish = () => {
				clearTimeout(timer);
				set.delete(finish);
				if (!set.size) this.#waiters.delete(repositoryId);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			let timer = setTimeout(finish, 20_000);
			set.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}
	async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
		let next = (this.#locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
		this.#locks.set(id, next);
		try {
			return await next;
		} finally {
			if (this.#locks.get(id) === next) this.#locks.delete(id);
		}
	}
}
