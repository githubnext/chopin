import { expect, test } from "bun:test";
import { applyInference, initialState } from "./domain";
import { effectsFor } from "./effects";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test.each(
	[
		["interrogative choice", "Should we use Auth0 or build our own authentication?", 0.97],
		["declarative choice", "We need to decide between Auth0 and a custom login system.", 0.93],
		["specific unknown", "How should we handle account recovery?", 0.65],
	] as const,
)("an actual %s can still open a card", async (_, text, newQuestion) => {
	let current = message(`actual-${newQuestion}`, text);
	let state = initialState();
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
					? { enough_purpose: 0.98, new_question: newQuestion, significance: 2 }
					: { c0_role: "question", c0_thread: "new" },
			),
	});
	expect(output.events.map(event => event.type)).toEqual(["thread.opened"]);
	let accepted = applyInference(state, output.events[0]!, current);
	expect(effectsFor(output.events, accepted).map(effect => effect.kind)).toContain(
		"insert-card",
	);
});
