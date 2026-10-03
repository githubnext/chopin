import { expect, test } from "bun:test";
import { initialState } from "./domain";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test.each(
	[
		[
			"option-only prose",
			"Auth0 is an option. Custom login is another.",
			{ new_question: 0.05, act: "proposal", thread_target: "none", new_option: 0.95 },
			{ c0_role: "option", c0_thread: "none", c1_role: "option", c1_thread: "none" },
		],
		[
			"mixed candidate roles",
			"Auth0 or custom login? React or Vue?",
			{ new_question: 0.97, act: "question", thread_target: "new" },
			{ c0_role: "option", c0_thread: "new", c1_role: "reason", c1_thread: "none" },
		],
		[
			"uncertain new target",
			"Should we use Auth0? Or custom login?",
			{ new_question: 0.97, act: "question", thread_target: "none" },
			{ c0_role: "option", c0_thread: "new", c1_role: "option", c1_thread: "none" },
		],
		[
			"repeated option labels",
			"Use Auth0. Use Auth0.",
			{ new_question: 0.97, act: "question", thread_target: "new" },
			{ c0_role: "option", c0_thread: "new", c1_role: "option", c1_thread: "none" },
		],
	] as const,
)("multi-option grouping refuses %s", async (_, text, triage, targeting) => {
	let current = message("not-a-group", text);
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
					? { ...triage, significance: 2 }
					: { ...targeting, c0_new_option: 0.95, c1_new_option: 0.95 },
			),
	});
	expect(output.events).toEqual([]);
});
