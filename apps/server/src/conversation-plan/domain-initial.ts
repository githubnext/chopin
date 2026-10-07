import type { ConversationPlan } from "@chopin/protocol";
import { emptyResearchState } from "./research-state";

type State = ConversationPlan.State;

export function initialState(): State {
	return {
		schemaVersion: 2,
		revision: 0,
		events: [],
		threads: [],
		queue: [],
		analysis: [],
		researchOffers: [],
		research: emptyResearchState(),
	};
}
