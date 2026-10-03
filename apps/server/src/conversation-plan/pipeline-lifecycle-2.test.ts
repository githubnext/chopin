import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { decided } from "./pipeline-lifecycle.test-fixtures";

test("material concern and direct request only propose reopening diagnostics", () => {
	let state = decided();
	let objection = message("m3", "The blank link is too easy to miss.");
	let review = planEvents({
		channelId: "channel",
		message: objection,
		state,
		first: first({ objection: 0.9 }),
		candidates: [
			{
				quote: objection.text,
				start: 0,
				end: objection.text.length,
				answers: follow({ role: "objection", thread: "thread-a", material_objection: 0.92 }),
			},
		],
	});
	expect(review.events.map((event) => event.type)).toContain("candidate.proposed");
	let reopen = message("m4", "Reopen the outline decision.");
	let direct = planEvents({
		channelId: "channel",
		message: reopen,
		state,
		first: first({ reopening: 0.98 }),
		candidates: [
			{
				quote: reopen.text,
				start: 0,
				end: reopen.text.length,
				answers: follow({ role: "reopening", thread: "thread-a", reopening: 0.98 }),
			},
		],
	});
	expect(direct.events.map((event) => event.type)).toEqual(["candidate.proposed"]);
	expect(direct.events[0]).toMatchObject({ candidate: { kind: "reopening" } });
	expect(state.threads[0].status).toBe("decided");
	expect(state.threads[0].decisionHistory).toHaveLength(1);
});

test("a .69 material concern proposes one human reopening review for a decided thread", () => {
	let state = decided();
	let current = message(
		"material",
		"I'm worried the blank link is hidden. A newcomer may miss it.",
	);
	let quotes = extractQuotes(current.text);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ objection: 0.58 }),
			significance: {
				type: "score",
				score: 1.83,
				confidence: 0.8,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0.17, "2": 0.83, "3": 0 },
			},
		},
		candidates: quotes.map((quote) => ({
			...quote,
			answers: follow({ role: "objection", thread: "thread-a", material_objection: 0.69 }),
		})),
	});
	expect(output.events.map((event) => event.type)).toEqual(["candidate.proposed"]);
	expect(output.outcomes).toHaveLength(2);
	expect(output.outcomes[0].status).toBe("review");
	expect(output.outcomes[1].gate).toContain("already proposed");
	expect(state.threads[0].status).toBe("decided");
});
