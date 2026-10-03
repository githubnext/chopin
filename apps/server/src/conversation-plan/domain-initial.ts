import type { ConversationPlan } from "@chopin/protocol";

type State = ConversationPlan.State;

export function initialState(): State {
	return {
		schemaVersion: 1,
		revision: 0,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
		researchOffers: [],
	};
}
