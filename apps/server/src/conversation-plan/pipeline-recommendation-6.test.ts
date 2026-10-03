import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { planEvents } from "./policy";
import { seeded, seededOptionId } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";

test("two distinct supporters produce tentative leaning, not a decision", () => {
	let state = seeded();
	let proposal = message("option", "Use an optional outline.");
	state = applyInference(state, {
		id: "option-event",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: 1,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: proposal.id,
			author: proposal.author as ConversationPlan.SourceAuthor,
			quote: proposal.text,
			start: 0,
			end: proposal.text.length,
			role: "option",
		},
		contribution: {
			id: seededOptionId,
			text: proposal.text,
			authoring: "quoted",
			targetId: "thread-a",
		},
	}, proposal);
	let firstSupport = message("first-support", "I support the optional outline.", "Theo");
	state = applyInference(state, {
		id: "first-stance",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "thread-a",
		observedThreadVersion: 2,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: firstSupport.id,
			author: firstSupport.author as ConversationPlan.SourceAuthor,
			quote: firstSupport.text,
			start: 0,
			end: firstSupport.text.length,
			role: "support",
		},
		optionId: seededOptionId,
		position: "support",
	}, firstSupport);
	let current = message("second-support", "I also support the optional outline.", "Imani");
	let answers = {
		...follow({ role: "support", thread: "thread-a" }),
		option: {
			type: "choice",
			choice: seededOptionId,
			confidence: 0.95,
			probabilities: { [seededOptionId]: 0.95, none: 0.05 },
		},
	};
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ support: 0.95 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: answers as any,
		}],
	});
	expect(output.events.map((event) => event.type)).toEqual(["stance.changed", "thread.leaning"]);
});
