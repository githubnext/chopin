import { analysisForMessage, messageLinks } from "./links";

import type { ConversationPlan } from "@chopin/protocol";
import type { CardLink } from "./links";

export type Lane = "decision" | "research";

/** Everything one message changed on one decision card. */
export type CardChange = {
	threadId: string;
	title: string;
	labels: string[];
	link: CardLink;
};

export type MessageOutcome = {
	changes: CardChange[];
	failed: Lane[];
	research?: "offered" | "pending" | "none" | "failed";
	pending: boolean;
	heading: string;
	tone: "success" | "warning" | "neutral";
};

const PHRASES: Record<string, string> = {
	Question: "New decision",
	Proposal: "Option on",
	Reason: "Reason on",
	Constraint: "Constraint on",
	Support: "Support on",
	Objection: "Objection on",
	Reopening: "Reopened",
	Settle: "Ready to settle",
};

/** "Option and reason on" or "New decision" — the words before a card title. */
export function changePhrase(labels: readonly string[]): string {
	let [first, ...rest] = labels;
	if (!first) return "Added to";
	if (rest.length === 0) return PHRASES[first] ?? `${first} on`;
	let nouns = labels.filter(label => PHRASES[label]?.endsWith(" on"));
	if (nouns.length === labels.length) {
		let words = nouns.map((label, index) => {
			let noun = PHRASES[label]!.slice(0, -" on".length);
			return index === 0 ? noun : noun.toLowerCase();
		});
		let list = words.length === 2
			? words.join(" and ")
			: `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
		return `${list} on`;
	}
	return "Added to";
}

export function messageOutcome(
	state: ConversationPlan.State,
	messageId: string,
): MessageOutcome {
	let analysis = analysisForMessage(state, messageId);
	let research = state.research?.analysis.find(item => item.messageId === messageId);
	let researchQueue = state.research?.queue.find(item => item.messageId === messageId);
	let changes: CardChange[] = [];
	for (let link of messageLinks(state, messageId)) {
		let change = changes.find(item => item.threadId === link.threadId);
		if (change) {
			if (!change.labels.includes(link.label)) change.labels.push(link.label);
			continue;
		}
		let title = state.threads.find(thread => thread.id === link.threadId)?.question;
		if (title) changes.push({ threadId: link.threadId, title, labels: [link.label], link });
	}
	let failed: Lane[] = [];
	if (analysis?.status === "failed") failed.push("decision");
	let researchFailed = research?.status === "failed"
		|| (!research && researchQueue?.status === "failed");
	if (researchFailed) failed.push("research");
	let researchState: MessageOutcome["research"] = researchFailed
		? "failed"
		: research?.status === "applied" && research.offerId
		? "offered"
		: researchQueue
		? "pending"
		: research
		? "none"
		: undefined;
	let pending = analysis?.status === "queued" || analysis?.status === "running"
		|| researchState === "pending";
	let heading = failed.includes("decision")
		? "Couldn’t analyse this message"
		: changes.length > 1
		? `Added to ${changes.length} decisions`
		: changes.length === 1
		? changes[0]!.labels.join() === "Question" ? "New decision" : "Added to a decision"
		: researchState === "offered"
		? "Research suggested"
		: researchState === "failed"
		? "Couldn’t check for research"
		: pending
		? "Analysing…"
		: "No changes";
	let tone: MessageOutcome["tone"] = failed.length
		? "warning"
		: changes.length || researchState === "offered"
		? "success"
		: "neutral";
	return { changes, failed, research: researchState, pending, heading, tone };
}
