import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { interpretMessage } from "./interpret";
import { mockResult, seeded } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("a new question keeps two unique quoted options when a third repeats one", async () => {
	let current = message(
		"repeat-option",
		"Should we use Auth0? Or GitHub auth? Or GitHub auth?",
	);
	let calls = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: initialState(),
		ask: async request =>
			mockResult(
				request.questions,
				calls++ === 0
					? { new_question: 0.97, act: "question", thread_target: "new", significance: 2 }
					: {
						c0_role: "option",
						c0_thread: "new",
						c0_new_option: 0.95,
						c1_role: "option",
						c1_thread: "none",
						c1_new_option: 0.95,
						c2_role: "option",
						c2_thread: "none",
						c2_new_option: 0.95,
					},
			),
	});
	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
	]);
	expect(
		output.events.flatMap(event => event.type === "option.added" ? [event.source?.quote] : []),
	).toEqual([
		"Should we use Auth0?",
		"Or GitHub auth?",
	]);
	expect(output.analysis.outcomes?.[2]?.gate).toBe("duplicate option in new question");
});

test("multi-option grouping leaves options for an existing thread on that thread", async () => {
	let state = seeded();
	let current = message("existing-options", "Use Auth0. Use custom login.");
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
	expect(output.events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(output.events.map(event => event.threadId)).toEqual(["thread-a", "thread-a"]);
});
