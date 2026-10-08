import { randomBytes } from "node:crypto";
import type { Source } from "@chopin/experiment";
import { fail, fingerprint } from "./service";

export type PairingInput = Omit<Source, "repositoryId"> & { label: string };
export type Connection = {
	id: string;
	documentId: string;
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
	expiresAt: number;
	connection?: Connection;
	token?: string;
};
export type Grant = { connectionId: string; run?: { id: string; generation: number } };

export class Connections {
	#pending = new Map<string, Pending>();
	#connections = new Map<string, Connection>();
	#tokens = new Map<string, Grant>();
	#runTokens = new Map<string, string>();
	#waiters = new Map<string, Set<() => void>>();
	#locks = new Map<string, Promise<unknown>>();
	constructor(private now = () => Date.now()) {}
	create(input: PairingInput) {
		this.sweep();
		if (this.#pending.size >= 100) fail("pairing-capacity");
		let secret = randomBytes(32).toString("base64url");
		let id = crypto.randomUUID();
		this.#pending.set(id, {
			id,
			input,
			proof: fingerprint(secret),
			expiresAt: this.now() + 300_000,
		});
		return { id, secret };
	}
	pending(id: string) {
		let value = this.#pending.get(id);
		if (!value || value.expiresAt <= this.now()) fail("pairing-expired");
		return value;
	}
	approve(
		id: string,
		owner: { id: string; login: string; sessionId: string },
		documentId: string,
		repositoryId: string,
	) {
		let value = this.pending(id);
		if (value.connection) {
			if (value.connection.owner !== owner.id || value.connection.documentId !== documentId) {
				fail("already-paired");
			}
			return value.connection;
		}
		if (this.list(documentId).filter(item => item.owner === owner.id).length >= 8) {
			fail("connection-limit");
		}
		let { label, ...source } = value.input;
		let connection: Connection = {
			id: crypto.randomUUID(),
			documentId,
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
	list(documentId: string) {
		return [...this.#connections.values()].filter(value =>
			value.documentId === documentId && value.expiresAt > this.now()
		);
	}
	runToken(connectionId: string, id: string, generation: number) {
		let key = `${connectionId}:${id}:${generation}`;
		let existing = this.#runTokens.get(key);
		if (existing) return existing;
		let token = randomBytes(32).toString("base64url");
		this.#runTokens.set(key, token);
		this.#tokens.set(fingerprint(token), { connectionId, run: { id, generation } });
		return token;
	}
	revoke(id: string) {
		let connection = this.#connections.get(id);
		this.#connections.delete(id);
		for (let key of this.#runTokens.keys()) {
			if (key.startsWith(`${id}:`)) this.#runTokens.delete(key);
		}
		for (let [key, grant] of this.#tokens) if (grant.connectionId === id) this.#tokens.delete(key);
		if (connection) this.wake(connection.documentId);
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
	wake(documentId: string) {
		for (let resolve of this.#waiters.get(documentId) ?? []) resolve();
	}
	wait(documentId: string, signal: AbortSignal) {
		return new Promise<void>(resolve => {
			let set = this.#waiters.get(documentId) ?? new Set();
			this.#waiters.set(documentId, set);
			let finish = () => {
				clearTimeout(timer);
				set.delete(finish);
				if (!set.size) this.#waiters.delete(documentId);
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
