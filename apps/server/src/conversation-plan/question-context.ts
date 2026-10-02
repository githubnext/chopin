import type { ConversationPlan } from "@chopin/protocol";
import type { LinkedCardOptions } from "./question-shared";
import { effectivePending } from "./preference";

export type VisibleThread = {
	thread: ConversationPlan.Thread;
	options: ConversationPlan.Contribution[];
};

export function visibleThreads(threads: readonly ConversationPlan.Thread[]): VisibleThread[] {
	let ordered = [
		...threads.filter((thread) => thread.status !== "discarded"),
		...threads.filter((thread) => thread.status === "discarded"),
	].slice(0, 12);
	let available = ordered.map((thread) =>
		thread.contributions.filter((item) => item.kind === "option").slice(-8).reverse()
	);
	let visible = ordered.map((thread) => ({
		thread,
		options: [] as ConversationPlan.Contribution[],
	}));
	let count = 0;
	for (let depth = 0; depth < 8 && count < 32; depth++) {
		for (let index = 0; index < ordered.length && count < 32; index++) {
			let option = available[index][depth];
			if (!option) continue;
			visible[index].options.push(option);
			count++;
		}
	}
	return visible;
}

export function cardChoices(
	selected: readonly VisibleThread[],
	linkedCards: LinkedCardOptions,
): Record<string, string> {
	let choices: Record<string, string> = {};
	for (let { thread } of selected) {
		let card = linkedCards.get(thread.id);
		if (!card || card.cardId !== thread.questionnaireId) continue;
		for (let option of card.options) {
			if (["new", "none"].includes(option.id)) throw new Error("reserved card option ID");
			choices[option.id] = `${option.label.slice(0, 100)} (in ${thread.question.slice(0, 100)})`;
		}
	}
	return choices;
}

export function compactThreads(
	selected: readonly VisibleThread[],
	events: readonly ConversationPlan.Event[] = [],
	linkedCards: LinkedCardOptions = new Map(),
) {
	return selected.map(({ thread, options }) => {
		let pending = effectivePending(thread, events);
		let pendingOption = pending
			&& thread.contributions.find((item) => item.id === pending.optionId);
		let card = linkedCards.get(thread.id);
		let visibleOptions = options.map((item) => ({
			id: item.id,
			text: (item.displayLabel ?? item.text).slice(0, 100),
		}));
		if (card && card.cardId === thread.questionnaireId) {
			for (let option of card.options) {
				if (!visibleOptions.some(item => item.id === option.id)) {
					visibleOptions.push({ id: option.id, text: option.label.slice(0, 100) });
				}
			}
		}
		return {
			id: thread.id,
			question: thread.question.slice(0, 160),
			status: thread.status,
			options: visibleOptions,
			contributions: thread.contributions.filter((item) => item.kind !== "option")
				.sort((a, b) => Number(Boolean(b.targetEditedBy)) - Number(Boolean(a.targetEditedBy)))
				.slice(0, 4)
				.map((item) => ({
					id: item.id,
					text: item.text.slice(0, 100),
					targetId: item.targetId,
					relation: item.relation,
				})),
			stances: thread.stances.slice(-6).map((item) => ({
				participant: item.participant,
				optionId: item.optionId,
				position: item.position,
			})),
			decision: thread.decision?.text.slice(0, 160),
			pendingSettle: pending && {
				optionId: pending.optionId,
				option: pendingOption
					&& (pendingOption.displayLabel ?? pendingOption.text).slice(0, 100),
				proposer: pending.proposer,
			},
		};
	});
}

export function fitState<
	T extends {
		threads: ReturnType<typeof compactThreads>;
		recent: Array<{ text: string }>;
	},
>(state: T): T {
	let withinBudget = () => JSON.stringify(state).length <= 23_500;
	if (withinBudget()) return state;
	for (let thread of state.threads) {
		thread.contributions = thread.contributions.slice(0, 1);
		thread.stances = thread.stances.slice(-2);
		thread.decision = thread.decision?.slice(0, 80);
	}
	if (withinBudget()) return state;
	for (let thread of state.threads) {
		thread.contributions = [];
		thread.stances = [];
		thread.decision = undefined;
	}
	if (withinBudget()) return state;
	for (let thread of state.threads) {
		thread.question = thread.question.slice(0, 80);
		for (let option of thread.options) option.text = option.text.slice(0, 40);
	}
	while (!withinBudget() && state.recent.length) state.recent.shift();
	if (!withinBudget()) throw new Error("conversation context exceeds Jev state budget");
	return state;
}

export function threadChoices(selected: readonly VisibleThread[]): Record<string, string> {
	let choices: Record<string, string> = {};
	for (let { thread } of selected) {
		if (["new", "none"].includes(thread.id)) throw new Error("reserved conversation thread ID");
		choices[thread.id] = `${thread.question.slice(0, 160)} (${thread.status})`;
	}
	choices.new = "A distinct planning question not represented by a current thread.";
	choices.none = "No planning thread is clearly referred to; do not guess from proximity alone.";
	return choices;
}
