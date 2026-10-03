import type { ConversationPlan } from "@chopin/protocol";
import { isDeepStrictEqual } from "node:util";
import { initialState } from "./domain-initial";
import { applyEvent } from "./events";
import { researchNamedOptionIds } from "./validation";

type State = ConversationPlan.State;
type Event = ConversationPlan.Event;

export function taskOptionLabels(state: State, task: ConversationPlan.ResearchTask) {
	let thread = state.threads.find(item => item.id === task.threadId);
	return task.options.map(option => {
		let contribution = thread?.contributions.find(item =>
			item.kind === "option" && item.id === option.id
		);
		return contribution ? contribution.displayLabel ?? contribution.text : undefined;
	});
}

export function taskSnapshot(state: State, task: ConversationPlan.ResearchTask) {
	let labels = taskOptionLabels(state, task);
	if (task.kind === "current-cost-comparison") return labels;
	let thread = state.threads.find(item => item.id === task.threadId);
	return {
		labels,
		currentOptionIds: thread?.contributions.filter(item => item.kind === "option")
			.map(item => item.id),
	};
}

export function taskMatches(state: State, task: ConversationPlan.ResearchTask): boolean {
	let thread = state.threads.find(item => item.id === task.threadId);
	return !!thread && thread.version === task.observedThreadVersion
		&& (task.kind === "current-cost-comparison"
			|| isDeepStrictEqual(
				thread.contributions.filter(item => item.kind === "option").map(item => item.id),
				task.options.map(item => item.id),
			))
		&& taskOptionLabels(state, task).every((label, index) =>
			label === task.options[index].labelAtOffer
		);
}

export function namesStaleResearchOption(
	state: State,
	task: ConversationPlan.ResearchTask,
	quote: string,
): boolean {
	if (task.kind !== "current-cost-concern") return false;
	let currentNames = new Set(researchNamedOptionIds(quote, task.options));
	let currentLabels = new Map(task.options.map(option => [option.id, option.labelAtOffer]));
	let displayLabels = new Set<string>();
	let oldName = (id: string, label: string) =>
		label !== currentLabels.get(id) && !currentNames.has(id)
		&& researchNamedOptionIds(quote, [{ id, labelAtOffer: label }]).length > 0;
	for (let event of state.events.slice(0, task.observedEventCount)) {
		if (event.type === "option.added" && currentLabels.has(event.contribution.id)) {
			if (oldName(event.contribution.id, event.contribution.text)) return true;
		} else if (event.type === "option.relabeled" && currentLabels.has(event.optionId)) {
			displayLabels.add(event.optionId);
			if (oldName(event.optionId, event.label)) return true;
		} else if (
			event.type === "card.corrected" && event.change.kind === "edit"
			&& event.change.field === "contribution"
			&& currentLabels.has(event.change.contributionId)
			&& !displayLabels.has(event.change.contributionId)
		) {
			if (oldName(event.change.contributionId, event.change.text)) return true;
		}
	}
	return false;
}

export function taskLabelChanges(
	events: readonly Event[],
	tasks: readonly ConversationPlan.ResearchOffer[],
) {
	let changes = new Map<string, number[]>();
	if (tasks.length === 0) return changes;
	let state = initialState();
	for (let [eventIndex, event] of events.entries()) {
		let before = tasks.map(offer => taskSnapshot(state, offer.task!));
		state = applyEvent(state, event);
		for (let [index, offer] of tasks.entries()) {
			if (!isDeepStrictEqual(before[index], taskSnapshot(state, offer.task!))) {
				changes.set(offer.id, [...(changes.get(offer.id) ?? []), eventIndex]);
			}
		}
	}
	return changes;
}
