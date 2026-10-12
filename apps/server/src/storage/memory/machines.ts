import { conflict, missing } from "../errors";

import type { CreateMachine, StoredMachine } from "../model";
import type { MachineStore } from "../port";

function copy(value: StoredMachine): StoredMachine {
	return structuredClone(value);
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

export class MemoryMachineStore implements MachineStore {
	#machines = new Map<string, StoredMachine>();
	#tokens = new Map<string, string>();
	constructor(private userExists: (id: string) => boolean) {}
	async create(input: CreateMachine) {
		if (!this.userExists(input.userId)) throw missing(`user ${input.userId} does not exist`);
		if (this.#machines.has(input.id) || this.#tokens.has(hex(input.tokenHash))) {
			throw conflict(`machine ${input.id} already exists`);
		}
		this.#machines.set(input.id, copy(input));
		this.#tokens.set(hex(input.tokenHash), input.id);
	}
	async get(id: string) {
		let found = this.#machines.get(id);
		return found && copy(found);
	}
	async byToken(tokenHash: Uint8Array) {
		let id = this.#tokens.get(hex(tokenHash));
		return id ? this.get(id) : undefined;
	}
	async list(userId: string) {
		return [...this.#machines.values()]
			.filter(value => value.userId === userId && !value.revokedAt)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.map(copy);
	}
	async seen(id: string, now: Date) {
		let found = this.#machines.get(id);
		if (found && !found.revokedAt) found.lastSeenAt = new Date(now);
	}
	async rotate(
		id: string,
		expectedRevision: number,
		credentials: StoredMachine["credentials"] & {},
	) {
		if (credentials.revision !== expectedRevision + 1) {
			throw conflict("invalid credential revision");
		}
		let found = this.#machines.get(id);
		if (!found || found.revokedAt || found.credentials?.revision !== expectedRevision) return false;
		found.credentials = structuredClone(credentials);
		return true;
	}
	async reauthorize(id: string, expectedRevision: number, now: Date) {
		let found = this.#machines.get(id);
		if (!found || found.revokedAt || found.credentials?.revision !== expectedRevision) return false;
		delete found.credentials;
		found.reauthorizeAt = new Date(now);
		return true;
	}
	async revoke(id: string, userId: string, now: Date) {
		let found = this.#machines.get(id);
		if (!found || found.userId !== userId || found.revokedAt) return false;
		delete found.credentials;
		found.revokedAt = new Date(now);
		return true;
	}
}
