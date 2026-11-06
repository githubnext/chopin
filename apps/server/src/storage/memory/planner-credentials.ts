import { conflict, missing } from "../errors";

import type { PlannerCredential } from "../model";
import type { PlannerCredentialStore } from "../port";

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function copy(value: PlannerCredential): PlannerCredential {
	return { ...value, digest: new Uint8Array(value.digest), expiresAt: new Date(value.expiresAt) };
}

export class MemoryPlannerCredentialStore implements PlannerCredentialStore {
	#credentials = new Map<string, PlannerCredential>();
	constructor(
		private deps: {
			machineExists: (id: string) => boolean;
			channelExists: (id: string) => boolean;
		},
	) {}
	async put(credential: PlannerCredential) {
		if (!this.deps.machineExists(credential.machineId)) {
			throw missing(`machine ${credential.machineId} does not exist`);
		}
		if (!this.deps.channelExists(credential.channelId)) {
			throw missing(`channel ${credential.channelId} does not exist`);
		}
		let key = hex(credential.digest);
		if (this.#credentials.has(key)) throw conflict("a Planner credential already has this digest");
		this.#credentials.set(key, copy(credential));
	}
	async find(digest: Uint8Array, now: Date) {
		let found = this.#credentials.get(hex(digest));
		return found && found.expiresAt > now ? copy(found) : undefined;
	}
	async delete(digest: Uint8Array) {
		return this.#credentials.delete(hex(digest));
	}
	async deleteForMachine(machineId: string, channelId?: string) {
		let removed = 0;
		for (let [key, value] of this.#credentials) {
			if (
				value.machineId === machineId && (channelId === undefined || value.channelId === channelId)
			) {
				this.#credentials.delete(key);
				removed++;
			}
		}
		return removed;
	}
	async deleteExpired(now: Date) {
		let removed = 0;
		for (let [key, value] of this.#credentials) {
			if (value.expiresAt <= now) {
				this.#credentials.delete(key);
				removed++;
			}
		}
		return removed;
	}
	deleteChannel(channelId: string) {
		for (let [key, value] of this.#credentials) {
			if (value.channelId === channelId) this.#credentials.delete(key);
		}
	}
}
