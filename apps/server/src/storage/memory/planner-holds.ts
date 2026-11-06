import { conflict, missing } from "../errors";

import type { Lease, PlannerLinkHold, StoredPlannerLinkHold } from "../model";
import type { PlannerLinkHoldStore } from "../port";

function copy(value: StoredPlannerLinkHold): StoredPlannerLinkHold {
	let { handoverUntil, ...rest } = value;
	return {
		...rest,
		sessions: structuredClone(value.sessions),
		suspendedAt: new Date(value.suspendedAt),
		...(handoverUntil ? { handoverUntil: new Date(handoverUntil) } : {}),
	};
}

export class MemoryPlannerLinkHoldStore implements PlannerLinkHoldStore {
	#holds = new Map<string, StoredPlannerLinkHold>();
	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			userExists: (id: string) => boolean;
			sessionExists: (id: string) => boolean;
			machineExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}
	async put(lease: Lease, input: PlannerLinkHold) {
		this.deps.assertLease(lease);
		if ((input.ownerSessionId === undefined) !== (input.machineId !== undefined)) {
			throw conflict("a Planner hold names a browser login or a paired machine, never both");
		}
		if (!this.deps.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (!this.deps.userExists(input.userId)) throw missing(`user ${input.userId} does not exist`);
		if (input.ownerSessionId !== undefined && !this.deps.sessionExists(input.ownerSessionId)) {
			throw missing(`session ${input.ownerSessionId} does not exist`);
		}
		if (input.machineId !== undefined && !this.deps.machineExists(input.machineId)) {
			throw missing(`machine ${input.machineId} does not exist`);
		}
		this.#holds.set(input.channelId, copy({ ...input, fencing: lease.fencing }));
	}
	async delete(lease: Lease, channelId: string) {
		this.deps.assertLease(lease);
		return this.#holds.delete(channelId);
	}
	async get(channelId: string) {
		let found = this.#holds.get(channelId);
		return found && copy(found);
	}
	async list() {
		return [...this.#holds.values()]
			.sort((a, b) => a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)
			.map(copy);
	}
	/** Whether a hold for the document names this login session. */
	holds(channelId: string, sessionId: string): boolean {
		return this.#holds.get(channelId)?.ownerSessionId === sessionId;
	}
	deleteChannel(channelId: string) {
		this.#holds.delete(channelId);
	}
	/** A hold goes with its owner's login session. */
	deleteSessions(ids: Iterable<string>) {
		let ended = new Set(ids);
		for (let [channelId, hold] of this.#holds) {
			if (hold.ownerSessionId !== undefined && ended.has(hold.ownerSessionId)) {
				this.#holds.delete(channelId);
			}
		}
	}
}
