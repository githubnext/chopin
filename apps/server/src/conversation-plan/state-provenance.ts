import type { Chat, ConversationPlan } from "@chopin/protocol";
import { validateSource } from "./sources";
import { taskLabelChanges } from "./research-snapshots";

type State = ConversationPlan.State;

function eventSecond(at: number): number {
	return Math.floor(at >= 100_000_000_000 ? at / 1_000 : at);
}

export function validateStateSourcesWithChanges(
	state: State,
	messages: ReadonlyMap<string, Chat.Entry> | readonly Chat.Entry[],
	labelChanges: ReadonlyMap<string, readonly number[]>,
): void {
	let lookup = Array.isArray(messages)
		? new Map(messages.map((message) => [message.id, message]))
		: messages as ReadonlyMap<string, Chat.Entry>;
	for (let event of state.events) {
		if ("source" in event && event.source) {
			let message = lookup.get(event.source.messageId);
			if (!message) throw new Error("conversation source message missing");
			validateSource(event.source, message);
		}
		if (event.type === "scoped-choice.saved") {
			for (let source of event.sources) {
				let message = lookup.get(source.messageId);
				if (!message) throw new Error("conversation source message missing");
				validateSource(source, message);
			}
		}
	}
	for (let offer of state.researchOffers ?? []) {
		let message = lookup.get(offer.source.messageId);
		if (!message) throw new Error("research offer source message missing");
		validateSource({ ...offer.source, role: "support" }, message);
		if (
			offer.task
			&& (labelChanges.get(offer.id) ?? []).some(index =>
				index >= offer.task!.observedEventCount
				&& eventSecond(state.events[index].at) <= message.ts
			)
		) throw new Error("research task source postdates its captured event prefix");
	}
}

export function validateStateSources(
	state: State,
	messages: ReadonlyMap<string, Chat.Entry> | readonly Chat.Entry[],
): void {
	let taskOffers = (state.researchOffers ?? []).filter(offer => offer.task);
	validateStateSourcesWithChanges(state, messages, taskLabelChanges(state.events, taskOffers));
}
