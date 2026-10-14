import { conflict, missing } from "../errors";

import type {
	CreateMachine,
	MachineChoice,
	MachineFavorite,
	MachineRepository,
	StoredMachine,
} from "../model";
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
	/** Keyed by document and person. */
	#choices = new Map<string, MachineChoice>();
	/** Each person's favorite machine, by person. */
	#favorites = new Map<string, string>();
	constructor(
		private userExists: (id: string) => boolean,
		private channelExists: (id: string) => boolean = () => true,
	) {}
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
	async rename(id: string, userId: string, label: string) {
		let found = this.#machines.get(id);
		if (!found || found.userId !== userId || found.revokedAt) return false;
		found.label = label;
		return true;
	}
	async revoke(id: string, userId: string, now: Date) {
		let found = this.#machines.get(id);
		if (!found || found.userId !== userId || found.revokedAt) return false;
		delete found.credentials;
		found.revokedAt = new Date(now);
		for (let [key, choice] of this.#choices) if (choice.machineId === id) this.#choices.delete(key);
		if (this.#favorites.get(userId) === id) this.#favorites.delete(userId);
		return true;
	}
	async serve(id: string, repository: MachineRepository) {
		let found = this.#machines.get(id);
		if (!found || found.revokedAt) return;
		if (found.repositories.some(value => value.repositoryId === repository.repositoryId)) return;
		found.repositories.push(structuredClone(repository));
	}
	async choices() {
		// A deleted document takes its choices with it, as the database's cascade does.
		return [...this.#choices.values()].filter(value => this.channelExists(value.channelId))
			.map(value => ({ ...value }));
	}
	async choose(choice: Omit<MachineChoice, "machineId"> & { machineId?: string }) {
		let key = `${choice.channelId}\n${choice.userId}`;
		if (!choice.machineId) {
			this.#choices.delete(key);
			return;
		}
		let found = this.#machines.get(choice.machineId);
		if (!found || found.revokedAt || found.userId !== choice.userId) {
			throw missing(`machine ${choice.machineId} is not the person's`);
		}
		if (!this.channelExists(choice.channelId)) {
			throw missing(`channel ${choice.channelId} is missing`);
		}
		this.#choices.set(key, {
			channelId: choice.channelId,
			userId: choice.userId,
			machineId: choice.machineId,
		});
	}
	async favorites() {
		return [...this.#favorites].map(([userId, machineId]) => ({ userId, machineId }));
	}
	async favor(favorite: Omit<MachineFavorite, "machineId"> & { machineId?: string }) {
		if (!favorite.machineId) {
			this.#favorites.delete(favorite.userId);
			return;
		}
		let found = this.#machines.get(favorite.machineId);
		if (!found || found.revokedAt || found.userId !== favorite.userId) {
			throw missing(`machine ${favorite.machineId} is not the person's`);
		}
		this.#favorites.set(favorite.userId, favorite.machineId);
	}
}
