import type { Chat, ConversationPlan } from "@chopin/protocol";
import { isDeepStrictEqual } from "node:util";
import { initialState } from "./domain-initial";
import { applyEvent, currentScopedProposal } from "./events";
import { assertStateShape } from "./validation";
import { namesStaleResearchOption, taskMatches, taskSnapshot } from "./research-snapshots";
import { validateStateSourcesWithChanges } from "./state-provenance";

type State = ConversationPlan.State;

export function restoreState(
	raw: unknown,
	messages?: ReadonlyMap<string, Chat.Entry> | readonly Chat.Entry[],
): State {
	if (raw === undefined) return initialState();
	assertStateShape(raw);
	let tasks = (raw.researchOffers ?? []).filter(offer => offer.task);
	let captures = new Map<number, typeof tasks>();
	for (let offer of tasks) {
		let count = offer.task!.observedEventCount;
		captures.set(count, [...(captures.get(count) ?? []), offer]);
	}
	let matched = new Set<string>();
	let rebuilt = initialState();
	let changes = new Map<string, number[]>();
	let checkCapture = (count: number) => {
		for (let offer of captures.get(count) ?? []) {
			if (offer.task && taskMatches(rebuilt, offer.task)) matched.add(offer.id);
		}
	};
	checkCapture(0);
	for (let [eventIndex, event] of raw.events.entries()) {
		let before = tasks.map(offer => taskSnapshot(rebuilt, offer.task!));
		rebuilt = applyEvent(rebuilt, event);
		for (let [index, offer] of tasks.entries()) {
			if (!isDeepStrictEqual(before[index], taskSnapshot(rebuilt, offer.task!))) {
				changes.set(offer.id, [...(changes.get(offer.id) ?? []), eventIndex]);
			}
		}
		checkCapture(rebuilt.events.length);
	}
	let restored = structuredClone(raw);
	for (let thread of restored.threads) {
		let pending = thread.pendingScopedChoice;
		if (!pending || pending.proposalId !== undefined) continue;
		let proposal = currentScopedProposal(thread, restored.events);
		if (!proposal) throw new Error("scoped choice proposal is ambiguous or missing");
		pending.proposalId = proposal.id;
	}
	if (
		!isDeepStrictEqual(
			JSON.parse(JSON.stringify(rebuilt.threads)),
			JSON.parse(JSON.stringify(restored.threads)),
		)
		|| rebuilt.events.length !== raw.events.length || raw.revision < rebuilt.revision
	) {
		throw new Error("conversation plan snapshot does not match its events");
	}
	if (matched.size !== tasks.length) {
		throw new Error("research task capture does not match history");
	}
	if (
		tasks.some(offer =>
			offer.task
			&& namesStaleResearchOption(raw, offer.task, offer.source.quote)
		)
	) {
		throw new Error("research task source names a stale option");
	}
	if (messages) validateStateSourcesWithChanges(restored, messages, changes);
	return restored;
}
