import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";

test("triage corroboration can accept a useful option with uncertain role, while vague chatter stays unlinked", () => {
	let state = seeded();
	let current = message("optional", "Keep setup optional.");
	let option = follow({ role: "option", thread: "thread-a" });
	option.role = {
		type: "choice",
		choice: "option",
		confidence: 0.56,
		probabilities: { option: 0.56, question: 0.42, none: 0.02 },
	};
	let useful = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.91 }),
			significance: {
				type: "score",
				score: 2.4,
				confidence: 0.8,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
				probabilities: { "0": 0, "1": 0, "2": 0.6, "3": 0.4 },
			},
		},
		candidates: [{ quote: current.text, start: 0, end: current.text.length, answers: option }],
	});
	expect(useful.events.map((event) => event.type)).toEqual(["option.added"]);
	let vague = message("vague", "That sounds like a lot for the first hour.");
	let objection = follow({ role: "objection", thread: "thread-a" });
	let ignored = planEvents({
		channelId: "channel",
		message: vague,
		state,
		first: {
			...first({ objection: 0.52, evidence: 0.6 }),
			significance: {
				type: "score",
				score: 0.65,
				confidence: 0.9,
				legend: { "0": "chatter", "1": "minor" },
				probabilities: { "0": 0.35, "1": 0.65 },
			},
		},
		candidates: [{ quote: vague.text, start: 0, end: vague.text.length, answers: objection }],
	});
	expect(ignored.events).toEqual([]);
});

test("one strong option quote cannot authorize another quote's weak option label", () => {
	let state = seeded();
	let current = message(
		"mixed-role",
		"Start with an optional outline. I'll check the draft tomorrow.",
	);
	let quotes = extractQuotes(current.text);
	let weakOption = {
		...follow({ role: "option", thread: "thread-a" }),
		role: {
			type: "choice" as const,
			choice: "option",
			confidence: 0.56,
			probabilities: { option: 0.56, none: 0.42, question: 0.02 },
		},
	};
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.95 }),
			significance: {
				type: "score",
				score: 2,
				confidence: 1,
				legend: { "0": "chatter", "1": "minor", "2": "useful" },
				probabilities: { "0": 0, "1": 0, "2": 1 },
			},
		},
		candidates: [
			{ ...quotes[0], answers: { ...weakOption, new_option: { type: "noul", noul: 0.95 } } },
			{ ...quotes[1], answers: { ...weakOption, new_option: { type: "noul", noul: 0.05 } } },
		],
	});
	expect(result.events.map((event) => event.type)).toEqual(["option.added"]);
	expect(result.outcomes[1]).toMatchObject({ status: "ignored", start: quotes[1].start });
});
