import { expect, test } from "bun:test";
import { interpretMessage } from "./interpret";
import type { JevQuestion } from "./jev";
import { message, mockResult, seeded, settledBy, stateWithOption } from "./interpret.test-fixtures";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, pipeline.test.ts.
// Complete callbacks and helpers retained; injected offline transport only.

test("interprets a declarative pair for a different open topic through both Jev passes", async () => {
	let state = stateWithOption(
		"Which search service should we use?",
		"search-thread",
		"existing-search",
		"Use PostgreSQL search.",
	);
	let current = message("search-alternatives", "By search I mean Algolia or Meilisearch.");
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
					? { new_option: 0.05, thread_target: "search-thread", significance: 2 }
					: {
						c0_role: "none",
						c1_role: "none",
						c0_thread: "search-thread",
						c1_thread: "search-thread",
						c0_new_option: 0.05,
						c1_new_option: 0.85,
					},
			),
	});
	expect(calls).toBe(3);
	expect(output.events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(output.events.map(event => "source" in event && event.source)).toMatchObject([
		{ quote: "Algolia", start: 17, end: 24, role: "option" },
		{ quote: "Meilisearch", start: 28, end: 39, role: "option" },
	]);
});

test("a later target failure or inconsistent model cannot publish partial events", async () => {
	let current = message("partial", "Sounds good to me. What about agents? Copilot?", "Jules");
	for (let failure of ["transport", "model"] as const) {
		let calls = 0;
		let output = await interpretMessage({
			channelId: "channel",
			message: current,
			recent: [message("proposal", "Let's use GitHub.", "Mina")],
			state: settledBy(seeded(), "Mina"),
			ask: async request => {
				calls++;
				if (calls === 4 && failure === "transport") throw new Error("synthetic failure");
				let result = mockResult(request.questions, {
					new_question: 0.95,
					c0_owned_unretracted: 0.95,
					c1_owned_unretracted: 0.95,
					c2_owned_unretracted: 0.95,
					c0_role: "support",
					c0_thread: "thread-a",
					c0_support: 0.95,
					c0_agrees_with_settle: 0.95,
					c1_role: "question",
					c1_thread: "new",
				});
				if (calls === 3 && failure === "model") result.model = "other-model";
				return result;
			},
		});
		expect(calls).toBe(4);
		expect(output.events).toEqual([]);
		expect(output.analysis.status).toBe("failed");
		expect(output.analysis.passes).toHaveLength(1);
	}
});

test("out-of-order target replies retain their quote-specific answers", async () => {
	let current = message(
		"out-of-order",
		"Sounds good to me. What about agents? Copilot?",
		"Jules",
	);
	let release: Array<(result: ReturnType<typeof mockResult>) => void> = [];
	let requests: Array<Record<string, JevQuestion>> = [];
	let interpretation = interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: settledBy(seeded(), "Mina"),
		ask: request => {
			if ("new_question" in request.questions) {
				return Promise.resolve(mockResult(request.questions, { new_question: 0.95 }));
			}
			requests.push(request.questions);
			return new Promise(resolve => release.push(resolve));
		},
	});
	await Bun.sleep(0);
	expect(requests).toHaveLength(3);
	for (let index of [2, 1, 0]) {
		release[index]!(mockResult(requests[index]!, { [`c${index}_new_option`]: (index + 1) / 10 }));
	}
	let output = await interpretation;
	expect(output.analysis.passes.map(pass => pass.stage)).toEqual(["triage", "targeting"]);
	let answers = output.analysis.passes[1]!.answers;
	for (let index = 0; index < 3; index++) {
		expect(answers[`c${index}_new_option`]).toEqual({ type: "noul", noul: (index + 1) / 10 });
	}
});
