import type { Record as DecisionRecord } from "../questions/records";

/** One question still waiting for an answer when a build goes ahead without it. */
export type UnapprovedDecision = {
	/** The decision card. */
	id: string;
	questionId: string;
	/** `reopened` once someone took a settled answer back. */
	status: "open" | "reopened";
	prompt: string;
	options: string[];
};

/**
 * Every unanswered question of an open or reopened decision, in record order.
 * A reopened decision needs all of its questions answered again.
 */
export function unapprovedDecisions(records: Iterable<DecisionRecord>): UnapprovedDecision[] {
	let found: UnapprovedDecision[] = [];
	for (let record of records) {
		if (record.status !== "open" && record.status !== "reopened") continue;
		for (let question of record.definition.questions) {
			if (
				record.status === "open" && record.answers && Object.hasOwn(record.answers, question.id)
			) {
				continue;
			}
			found.push({
				id: record.id,
				questionId: question.id,
				status: record.status,
				prompt: question.question,
				options: question.options.map(option => option.label),
			});
		}
	}
	return found;
}

const SECTION = "Assumed, not yet approved";

/**
 * What a coding agent is told beside the document when decisions are still open: build on best
 * judgment, never settle them, and say in every pull request what was assumed. Nothing when none
 * is open. The document's own decision blocks are data; this list is the agent's instruction.
 */
export function unapprovedContext(records: Iterable<DecisionRecord>) {
	let decisions = unapprovedDecisions(records);
	if (decisions.length === 0) return;
	let lines = decisions.map(item => {
		let prompt = item.prompt.replace(/\s+/g, " ").trim();
		return item.options.length > 0 ? `- ${prompt} (${item.options.join(", ")})` : `- ${prompt}`;
	});
	return {
		unapprovedDecisions: {
			instructions:
				"These decisions are still open. Do not wait for them: use your best judgment and keep going, and never answer or close one. Put pullRequestSection, unchanged, at the end of the body of every pull request you open, then add a few words after each item on what you assumed.",
			decisions,
			pullRequestSection: [
				`## ${SECTION}`,
				"",
				"These decisions were still open when this was built, so it went ahead on best judgment. None has been answered.",
				"",
				...lines,
				"",
			].join("\n"),
		},
	};
}
