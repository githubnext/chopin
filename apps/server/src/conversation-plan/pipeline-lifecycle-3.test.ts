import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { applyEvent } from "./events";
import { planEvents } from "./policy";
import { interpretMessage } from "./interpret";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";
import { member, message } from "./policy-initial.test-fixtures";
import { mockResult, seeded } from "./interpret.test-fixtures";
import { decided, discarded } from "./pipeline-lifecycle.test-fixtures";

test("D01 recovery does not reopen the identical discarded question without a re-raise", () => {
	let input = d01RecordedOpening();
	let earlier = message("d01-earlier", input.message.text, "Nia");
	let prior = applyInference(initialState(), {
		id: "d01-earlier-open",
		type: "thread.opened",
		threadId: "d01-earlier-thread",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: earlier.ts,
		source: {
			messageId: earlier.id,
			author: earlier.author as ConversationPlan.SourceAuthor,
			quote: earlier.text,
			start: 0,
			end: earlier.text.length,
			role: "question",
		},
		question: earlier.text,
	}, earlier);
	let discarded = applyEvent(prior, {
		id: "d01-earlier-discard",
		type: "thread.discarded",
		threadId: "d01-earlier-thread",
		observedThreadVersion: prior.threads[0]!.version,
		origin: "human",
		actor: member("Nia"),
		at: earlier.ts + 1,
	});
	let repeated = {
		...input,
		message: { ...input.message, id: "d01-repeated", ts: earlier.ts + 2 },
		state: discarded,
	};
	expect(planEvents(repeated).events).toEqual([]);
});

test("multi-option grouping does not revive a discarded thread", async () => {
	let state = discarded(seeded());
	let current = message("discarded-options", "Use Auth0. Use custom login.");
	let calls = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state,
		ask: async request =>
			mockResult(
				request.questions,
				calls++ === 0
					? { new_question: 0.97, act: "question", thread_target: "new", significance: 2 }
					: {
						c0_role: "option",
						c0_thread: "thread-a",
						c0_new_option: 0.95,
						c1_role: "option",
						c1_thread: "thread-a",
						c1_new_option: 0.95,
					},
			),
	});
	expect(output.events).toEqual([]);
});

test("ignored chatter leaves accepted earlier decisions intact", async () => {
	let state = decided();
	let output = await interpretMessage({
		channelId: "channel",
		message: message("m6", "I'll check tomorrow."),
		recent: [],
		state,
		ask: async (request) => mockResult(request.questions, {}),
	});
	expect(output.events).toEqual([]);
	expect(state.threads[0].decisionHistory).toHaveLength(1);
});
