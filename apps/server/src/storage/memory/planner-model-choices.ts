import { missing } from "../errors";

import type { Lease, PlannerModelChoice } from "../model";
import type { PlannerModelChoiceStore } from "../port";

function copy(value: PlannerModelChoice): PlannerModelChoice {
	return { ...value, updatedAt: new Date(value.updatedAt) };
}

export class MemoryPlannerModelChoiceStore implements PlannerModelChoiceStore {
	#choices = new Map<string, PlannerModelChoice>();
	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			userExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}
	async put(lease: Lease, input: PlannerModelChoice) {
		this.deps.assertLease(lease);
		if (!this.deps.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (!this.deps.userExists(input.userId)) throw missing(`user ${input.userId} does not exist`);
		if (input.model === undefined && input.thinkingLevel === undefined) {
			this.#choices.delete(input.channelId);
			return;
		}
		this.#choices.set(input.channelId, copy(input));
	}
	async get(channelId: string) {
		let found = this.#choices.get(channelId);
		return found && copy(found);
	}
	deleteChannel(channelId: string) {
		this.#choices.delete(channelId);
	}
}
