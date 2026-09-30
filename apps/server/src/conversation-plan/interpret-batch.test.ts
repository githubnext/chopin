import { expect, test } from "bun:test";
import { interpretMessage } from "./interpret";
import { initialState } from "./domain";
import type { JevQuestion } from "./jev";
import { message, mockResult, seeded, settledBy } from "./interpret.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, pipeline.test.ts.
// Complete callbacks and helpers retained; injected offline transport only.

test("a failed target waits for its sibling before the next message starts", async () => {
	let current = message(
		"failed-batch",
		"Sounds good to me. What about agents? Copilot?",
		"Jules",
	);
	let next = message("next-message", "Should we use GitHub authentication?", "Mina");
	let release!: (result: ReturnType<typeof mockResult>) => void;
	let held = new Promise<ReturnType<typeof mockResult>>(resolve => release = resolve);
	let heldQuestions!: Record<string, JevQuestion>;
	let targetCalls = 0;
	let nextStarted = false;
	let first = interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: settledBy(seeded(), "Mina"),
		ask: request => {
			if ("new_question" in request.questions) {
				return Promise.resolve(mockResult(request.questions, { new_question: 0.95 }));
			}
			targetCalls++;
			if ("c0_role" in request.questions) {
				heldQuestions = request.questions;
				return held;
			}
			if ("c1_role" in request.questions) return Promise.reject(new Error("target failed"));
			return Promise.resolve(mockResult(request.questions, {}));
		},
	});
	let second = first.then(() =>
		interpretMessage({
			channelId: "channel",
			message: next,
			recent: [current],
			state: initialState(),
			ask: async request => {
				nextStarted = true;
				return mockResult(request.questions, {});
			},
		})
	);
	await Bun.sleep(0);
	expect(targetCalls).toBe(3);
	expect(nextStarted).toBe(false);
	release(mockResult(heldQuestions, {}));
	let failed = await first;
	await second;
	expect(failed.events).toEqual([]);
	expect(failed.analysis.status).toBe("failed");
	expect(failed.analysis.passes).toHaveLength(1);
	expect(nextStarted).toBe(true);
});
