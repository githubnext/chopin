import type { ConversationPlan } from "@chopin/protocol";
import { applyEvent } from "./events";
import { member } from "./policy-initial.test-fixtures";
import { seeded } from "./interpret.test-fixtures";

export function decided(): ConversationPlan.State {
	let state = seeded();
	return applyEvent(state, {
		id: "card:decision",
		type: "decision.recorded",
		threadId: "thread-a",
		observedThreadVersion: 1,
		origin: "human",
		actor: member("Ana"),
		at: 1000,
		text: "Use an optional outline",
		explicit: true,
	});
}

export function discarded(state: ConversationPlan.State): ConversationPlan.State {
	return applyEvent(state, {
		id: "card:discarded",
		type: "thread.discarded",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0].version,
		origin: "human",
		actor: member("Ana"),
		at: 1001,
	});
}
