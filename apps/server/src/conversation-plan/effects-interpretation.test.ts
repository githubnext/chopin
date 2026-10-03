import { expect, test } from "bun:test";
import { applyInference, initialState } from "./domain";
import { effectsFor } from "./effects";
import { interpretMessage } from "./interpret";
import { message, mockResult, seeded } from "./interpret.test-fixtures";
import { planEvents } from "./policy";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";

// Whole pipeline callbacks3532/3554/4479 from archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.

test("unlinked messages retain purpose evidence for later effects", async () => {
	let calls = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: message("purpose", "We're making a shared planning document."),
		recent: [],
		state: seeded(),
		ask: async (request) => {
			calls++;
			return mockResult(request.questions, { enough_purpose: 0.95 });
		},
	});
	expect(calls).toBe(1);
	expect(output.events).toEqual([]);
	expect(output.analysis.status).toBe("unlinked");
	expect(output.analysis.questionSetVersion).toBe("conversation-plan-8");
	expect(output.analysis.passes[0].answers.enough_purpose).toEqual({
		type: "noul",
		noul: 0.95,
	});
});

test("an opening purpose queues a heading but no card even if Jev calls it a question", async () => {
	let current = message("figma-purpose", "Okay we gotta figure out what we're doing for auth");
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
					? { enough_purpose: 0.98, new_question: 0.08, act: "question", significance: 2 }
					: { c0_role: "question", c0_thread: "new" },
			),
	});
	expect(calls).toBe(2);
	expect(output.analysis.passes[0]?.answers.act).toMatchObject({ choice: "question" });
	expect(output.events).toEqual([]);
	let effects = effectsFor(output.events, state, {
		...output.analysis,
		messageId: current.id,
		eventIds: [],
	});
	expect(effects).toMatchObject([{
		kind: "job",
		intent: { kind: "heading", target: "document", trigger: current.id },
	}]);
});

test("D01's owned purpose and final question open one editor-context card", () => {
	let input = d01RecordedOpening();
	expect(input.candidates.map(candidate => [candidate.quote, candidate.start, candidate.end]))
		.toEqual([
			["need to pick an editor before comments get any deeper.", 0, 54],
			["what are we comparing?", 55, 77],
		]);
	let output = planEvents(input);
	expect(output.events).toHaveLength(1);
	expect(output.events[0]).toMatchObject({
		type: "thread.opened",
		question: input.message.text,
		source: {
			messageId: input.message.id,
			author: input.message.author,
			quote: input.message.text,
			start: 0,
			end: input.message.text.length,
			role: "question",
		},
	});
	let accepted = applyInference(input.state, output.events[0]!, input.message);
	expect(effectsFor(output.events, accepted)).toContainEqual(expect.objectContaining({
		kind: "insert-card",
		header: input.message.text,
	}));
});
