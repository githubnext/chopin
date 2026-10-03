import type { Chat, ConversationPlan } from "@chopin/protocol";
import { initialState, offerResearch } from "./domain";
import { renderResearchTask } from "./validation";
import { applyEvent } from "./events";

export function message(id: string, text = "Look up the 🧵 hosting terms"): Chat.Entry {
	return { id, author: { kind: "member", handle: "ada" }, text, ts: 1 };
}

export function proposal(
	entry: Chat.Entry,
	id = `offer:${entry.id}`,
	needId = "hosting-terms",
	contextId = "v1",
): Omit<ConversationPlan.ResearchOffer, "status" | "action"> {
	return {
		id,
		needId,
		contextId,
		brief: entry.text,
		source: {
			messageId: entry.id,
			author: entry.author as ConversationPlan.SourceAuthor,
			quote: entry.text,
			start: 0,
			end: entry.text.length,
		},
	};
}

export let ada: Extract<Chat.Author, { kind: "member" }> = { kind: "member", handle: "ada" };
export let bo: Extract<Chat.Author, { kind: "member" }> = { kind: "member", handle: "bo" };
export let s3Id = "01K00000000000000000000001";
export let r2Id = "01K00000000000000000000002";
export let diskId = "01K00000000000000000000003";
export let postmarkId = "01K00000000000000000000004";
export let sesId = "01K00000000000000000000005";
export let mailgunId = "01K00000000000000000000006";

export type CostConcernTask = {
	kind: "current-cost-concern";
	threadId: string;
	observedEventCount: number;
	observedThreadVersion: number;
	options: Array<{ id: string; labelAtOffer: string }>;
	focusOptionId?: string;
};

export type CostConcernProposal =
	& Omit<ConversationPlan.ResearchOffer, "status" | "action" | "task">
	& { task: CostConcernTask };

export function optionThread(): ConversationPlan.State {
	let state = initialState();
	state = applyEvent(state, {
		id: "open",
		type: "thread.opened",
		threadId: "hosting",
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question: "Which storage?",
	});
	for (let [id, label] of [[s3Id, "S3"], [r2Id, "R2"]]) {
		state = applyEvent(state, {
			id: `add-${id}`,
			type: "option.added",
			threadId: "hosting",
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: state.revision + 1,
			contribution: { id, text: label, authoring: "scribe" },
		});
	}
	return state;
}

export function taskProposal(
	entry: Chat.Entry,
	state: ConversationPlan.State,
): Omit<ConversationPlan.ResearchOffer, "status" | "action"> {
	let task: ConversationPlan.ResearchTask = {
		kind: "current-cost-comparison",
		threadId: "hosting",
		observedEventCount: state.events.length,
		observedThreadVersion: state.threads[0]!.version,
		options: [{ id: s3Id, labelAtOffer: "S3" }, { id: r2Id, labelAtOffer: "R2" }],
	};
	return {
		...proposal(entry),
		threadId: "hosting",
		task,
		brief: renderResearchTask(task, proposal(entry).source),
	};
}

export function stateWithOptions(
	threadId: string,
	question: string,
	options: Array<{ id: string; label: string }>,
): ConversationPlan.State {
	let state = applyEvent(initialState(), {
		id: `open-${threadId}`,
		type: "thread.opened",
		threadId,
		observedThreadVersion: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1,
		question,
	});
	for (let option of options) {
		state = applyEvent(state, {
			id: `add-${option.id}`,
			type: "option.added",
			threadId,
			observedThreadVersion: state.threads[0]!.version,
			origin: "planner",
			actor: { kind: "agent" },
			at: state.revision + 1,
			contribution: { id: option.id, text: option.label, authoring: "scribe" },
		});
	}
	return state;
}

export function exactSource(
	entry: Chat.Entry,
	quote = entry.text,
): ConversationPlan.ResearchSource {
	let start = entry.text.indexOf(quote);
	if (start < 0) throw new Error("quote is missing from message");
	return {
		messageId: entry.id,
		author: entry.author as ConversationPlan.SourceAuthor,
		quote,
		start,
		end: start + quote.length,
	};
}

export function costConcernProposal(
	entry: Chat.Entry,
	state: ConversationPlan.State,
	focusOptionId?: string,
	quote = entry.text,
	threadId = "storage",
): CostConcernProposal {
	let thread = state.threads.find(item => item.id === threadId)!;
	let source = exactSource(entry, quote);
	let task: CostConcernTask = {
		kind: "current-cost-concern",
		threadId: thread.id,
		observedEventCount: state.events.length,
		observedThreadVersion: thread.version,
		options: thread.contributions
			.filter(item => item.kind === "option")
			.map(item => ({ id: item.id, labelAtOffer: item.displayLabel ?? item.text })),
		...(focusOptionId ? { focusOptionId } : {}),
	};
	return {
		...proposal(entry, `offer:${entry.id}`, "current-cost-concern", "storage-v1"),
		source,
		threadId: thread.id,
		task,
		brief: renderResearchTask(
			task as unknown as ConversationPlan.ResearchTask,
			source,
		),
	};
}

export function offerCostConcern(
	state: ConversationPlan.State,
	proposal: CostConcernProposal,
	entry: Chat.Entry,
) {
	return offerResearch(
		state,
		proposal as unknown as Omit<ConversationPlan.ResearchOffer, "status" | "action">,
		entry,
	);
}
