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

const NOUNS: Record<string, string> = {
	Option: "an option",
	Reason: "a reason",
	Constraint: "a constraint",
	Objection: "an objection",
	Support: "support",
};

/** One change as a sentence around the card title; `title: undefined` makes the phrase the link. */
export type ChangeSentence = { before: string; title?: string; after: string };

function plain(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function list(words: string[]): string {
	return words.length <= 2
		? words.join(" and ")
		: `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function changeSentence(change: CardChange, messageText = ""): ChangeSentence {
	let { labels, title } = change;
	if (labels.includes("Question")) {
		return plain(title) === plain(messageText)
			? { before: "Started a decision", after: "" }
			: { before: "Started the decision", title, after: "" };
	}
	if (labels.includes("Reopening")) return { before: "Reopened", title, after: "" };
	if (labels.includes("Suggested reopening")) {
		return { before: "Suggested reopening", title, after: "" };
	}
	if (labels.includes("Settle")) return { before: "Marked", title, after: "ready to settle" };
	let nouns = labels.filter(label => NOUNS[label]);
	if (nouns.length === 1 && nouns[0] === "Support") {
		return { before: "Counted as support for", title, after: "" };
	}
	if (nouns.length === 1) return { before: `Added as ${NOUNS[nouns[0]!]} to`, title, after: "" };
	if (nouns.length > 1) {
		return { before: `Added ${list(nouns.map(label => NOUNS[label]!))} to`, title, after: "" };
	}
	return { before: "Added to", title, after: "" };
}

/** The same sentence as plain text, for headings and accessible names. */
export function changeText(change: CardChange, messageText = ""): string {
	let sentence = changeSentence(change, messageText);
	return [sentence.before, sentence.title, sentence.after].filter(Boolean).join(" ");
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
		? changes[0]!.labels.includes("Question")
			? "Started a decision"
			: changes[0]!.labels.includes("Reopening")
			? "Reopened a decision"
			: changes[0]!.labels.includes("Suggested reopening")
			? "Suggested reopening"
			: "Added to a decision"
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
