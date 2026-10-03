import type { ConversationPlan } from "@chopin/protocol";

export type CardLink = {
	threadId: string;
	itemId: string;
	label: string;
	source: ConversationPlan.SourceRef;
};

/** Resolve against the current projection, so moved contributions keep useful backlinks. */
export function messageLinks(state: ConversationPlan.State, messageId: string): CardLink[] {
	let links: CardLink[] = [];
	let add = (
		threadId: string,
		itemId: string,
		label: string,
		sources: ConversationPlan.SourceRef[],
	) => {
		for (let source of sources) {
			if (source.messageId === messageId) links.push({ threadId, itemId, label, source });
		}
	};
	for (let thread of state.threads) {
		add(thread.id, thread.id, "Question", thread.questionSources);
		for (let item of thread.contributions) {
			let label = item.kind === "option" ? "Proposal" : item.kind === "reason"
				? "Reason"
				: "Constraint";
			add(thread.id, item.id, label, item.sources);
		}
		for (let stance of [...thread.stances, ...thread.stanceHistory]) {
			let label = stance.position === "support"
				? "Support"
				: stance.position === "oppose"
				? "Objection"
				: undefined;
			if (label) add(thread.id, stance.id, label, stance.sources);
		}
		for (let candidate of thread.candidates) {
			if (candidate.kind === "reopening") {
				add(thread.id, candidate.id, "Reopening", candidate.sources);
			}
		}
	}
	for (let event of state.events) {
		if (event.type !== "settle.suggested" && event.type !== "decision.reopened") continue;
		if (event.source?.messageId !== messageId) continue;
		let thread = state.threads.find(item => item.id === event.threadId);
		if (thread) {
			add(thread.id, thread.id, event.type === "decision.reopened" ? "Reopening" : "Settle", [
				event.source,
			]);
		}
	}
	return links.filter((link, index) =>
		links.findIndex(other =>
			other.itemId === link.itemId && other.source.start === link.source.start
			&& other.source.end === link.source.end
		) === index
	);
}

export function threadForCard(
	state: ConversationPlan.State,
	questionnaireId: string,
): ConversationPlan.Thread | undefined {
	return state.threads.find(thread => thread.questionnaireId === questionnaireId);
}

/** Prose jobs retain a generation trigger; show them beside the opening question. */
export function jobsForMessage(
	state: ConversationPlan.State,
	jobs: readonly ConversationPlan.Job[],
	messageId: string,
): ConversationPlan.Job[] {
	return jobs.filter(job =>
		job.trigger === messageId
		|| job.kind === "prose"
			&& threadForCard(state, job.target)?.questionSources[0]?.messageId === messageId
	);
}

export function analysisForMessage(state: ConversationPlan.State, messageId: string) {
	let record = state.analysis.find(item => item.messageId === messageId);
	if (record) return record;
	let queued = state.queue.find(item => item.messageId === messageId);
	if (!queued) return undefined;
	return {
		messageId,
		status: queued.status === "failed" ? "failed" : "queued",
		questionSetVersion: "",
		modelVersion: "",
		passes: [],
		eventIds: [],
		error: queued.error,
	} satisfies ConversationPlan.AnalysisRecord;
}
