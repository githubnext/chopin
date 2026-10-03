import * as Store from "./store";
import type { Plan } from "../plan/service";
import type { Record } from "./records";

/** Owner first, then card editors and the conversation's member participants. */
export function involved(plan: Plan, record: Record): string[] {
	let live = Store.get(plan.questions, record.id)?.editors ?? new Set<string>();
	let thread = plan.conversationPlan.threads.find(item =>
		item.questionnaireId === record.id || item.id === record.threadId
	);
	let sources = thread
		? [
			...thread.questionSources,
			...thread.contributions.flatMap(item => item.sources),
			...thread.stances.flatMap(item => item.sources),
			...thread.stanceHistory.flatMap(item => item.sources),
			...(thread.decision?.sources ?? []),
			...thread.decisionHistory.flatMap(item => item.sources),
			...thread.candidates.flatMap(item => item.sources),
		]
		: [];
	let authors = sources.flatMap(source =>
		source.author.kind === "member" ? [source.author.handle] : []
	);
	let stances = thread
		? [...thread.stances, ...thread.stanceHistory].map(item => item.participant)
		: [];
	return [
		...new Set([
			...(record.owner ? [record.owner] : []),
			...record.editors,
			...live,
			...authors,
			...stances,
		]),
	].slice(0, 8);
}
