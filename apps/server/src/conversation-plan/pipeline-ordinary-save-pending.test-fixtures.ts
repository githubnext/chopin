import type { Chat, ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 pipeline.test.ts declaration.
export function queueWithPendingSave(): { state: ConversationPlan.State; proposal: Chat.Entry } {
	let state = stateWithOption(
		"Which queue should handle background jobs?",
		"queue-thread",
		"sqs-option",
		"Use SQS.",
	);
	let postgres = message("postgres-queue-option", "Use a PostgreSQL queue.");
	state = applyInference(state, {
		id: postgres.id,
		type: "option.added",
		threadId: "queue-thread",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: postgres.ts,
		source: {
			messageId: postgres.id,
			author: postgres.author as ConversationPlan.SourceAuthor,
			quote: postgres.text,
			start: 0,
			end: postgres.text.length,
			role: "option",
		},
		contribution: {
			id: "postgres-option",
			text: postgres.text,
			authoring: "quoted",
			targetId: "queue-thread",
		},
	}, postgres);
	let proposal = message("pending-sqs-save", "We should use SQS.");
	return {
		state: applyInference(state, {
			id: "pending-sqs-save-event",
			type: "settle.suggested",
			threadId: "queue-thread",
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: proposal.ts,
			source: {
				messageId: proposal.id,
				author: proposal.author as ConversationPlan.SourceAuthor,
				quote: proposal.text,
				start: 0,
				end: proposal.text.length,
				role: "resolution",
			},
			optionId: "sqs-option",
		}, proposal),
		proposal,
	};
}
