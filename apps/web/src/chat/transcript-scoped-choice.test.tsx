import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import {
	agreement,
	agreementSource,
	proposal,
	proposalSource,
	saved,
	scopedNotice,
	scopedPlan,
	scopedTranscriptMarkup,
} from "./transcript-decisions.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a scoped proposal appears as an inline Save action with its proposer source", () => {
	let markup = scopedTranscriptMarkup(scopedNotice([proposalSource]), scopedPlan([proposal]));

	expect(markup).toContain("Save for this spike");
	expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Save for this spike<\/button>/);
	expect(markup).toContain("Mei");
	expect(markup).toContain("I&#x27;d pick Lexical for the spike;");
	expect(markup).not.toContain("Save decision");
	expect(markup).not.toContain("Decision prompt:");
});

test("an agreement refresh shows both exact source authors and quotes", () => {
	let markup = scopedTranscriptMarkup(
		scopedNotice([proposalSource, agreementSource]),
		scopedPlan([proposal, agreement]),
	);

	expect(markup).toContain("Save for this spike");
	expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Save for this spike<\/button>/);
	expect(markup).toContain("Mei");
	expect(markup).toContain("Rob");
	expect(markup).toContain("I&#x27;d pick Lexical for the spike;");
	expect(markup).toContain("yep, Lexical for the spike.");
	expect(markup).not.toContain("Save decision");
	expect(markup).not.toContain("Decision prompt:");
});

test("a durable scoped save disables the historical notice action", () => {
	let markup = scopedTranscriptMarkup(
		scopedNotice([proposalSource]),
		scopedPlan([proposal, saved]),
	);

	expect(markup).toContain("Saved for this spike");
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Saved for this spike<\/button>/);
	expect(markup).not.toContain("Save decision");
});

test("a relabeled option disables the historical scoped Save action", () => {
	let relabeled: ConversationPlan.Event = {
		id: "option-relabel:rename-m9",
		type: "option.relabeled",
		threadId: "thread-a",
		observedThreadVersion: 3,
		observedCardRevision: 0,
		origin: "planner",
		actor: { kind: "agent" },
		at: 1_700_000_003,
		optionId: "lexical",
		label: "JavaScript Lexical editor",
	};
	let markup = scopedTranscriptMarkup(
		scopedNotice([proposalSource, agreementSource]),
		scopedPlan([proposal, agreement, relabeled], "JavaScript Lexical editor"),
	);

	expect(markup).toContain("This choice has changed.");
	expect(markup).toMatch(
		/<button[^>]*disabled=""[^>]*>Save for this spike<\/button>/,
	);
});
