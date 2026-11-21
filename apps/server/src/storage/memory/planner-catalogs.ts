import { missing } from "../errors";

import type { Lease, PlannerCatalog } from "../model";
import type { PlannerCatalogStore } from "../port";

function copy(value: PlannerCatalog): PlannerCatalog {
	return { ...structuredClone(value), reportedAt: new Date(value.reportedAt) };
}

export class MemoryPlannerCatalogStore implements PlannerCatalogStore {
	#catalogs = new Map<string, PlannerCatalog>();
	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			userExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}
	async put(lease: Lease, input: PlannerCatalog) {
		this.deps.assertLease(lease);
		if (!this.deps.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (!this.deps.userExists(input.userId)) throw missing(`user ${input.userId} does not exist`);
		this.#catalogs.set(JSON.stringify([input.channelId, input.userId]), copy(input));
	}
	async get(channelId: string, userId: string) {
		let found = this.#catalogs.get(JSON.stringify([channelId, userId]));
		return found && copy(found);
	}
	async latest(userId: string) {
		let found: PlannerCatalog | undefined;
		for (let value of this.#catalogs.values()) {
			if (value.userId !== userId) continue;
			if (!found || value.reportedAt.getTime() > found.reportedAt.getTime()) found = value;
		}
		return found && copy(found);
	}
	deleteChannel(channelId: string) {
		for (let [key, value] of this.#catalogs) {
			if (value.channelId === channelId) this.#catalogs.delete(key);
		}
	}
}
