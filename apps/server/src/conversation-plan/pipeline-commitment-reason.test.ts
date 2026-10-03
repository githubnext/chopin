import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";

test("captures a causal reason despite a near tie with support, with a clear existing option", () => {
	let state = stateWithOption(
		"Which queue should handle background jobs?",
		"queue-thread",
		"sqs-option",
		"Use SQS.",
	);
	let current = message("sqs-reason", "SQS would reduce operations for us.");
	let answers = {
		...follow({ role: "reason", thread: "queue-thread" }),
		role: {
			type: "choice" as const,
			choice: "support",
			confidence: 0.38,
			probabilities: { reason: 0.39, support: 0.45, option: 0.13, resolution: 0.03 },
		},
		thread: {
			type: "choice" as const,
			choice: "queue-thread",
			confidence: 0.99,
			probabilities: { "queue-thread": 1, none: 0 },
		},
		option: {
			type: "choice" as const,
			choice: "sqs-option",
			confidence: 1,
			probabilities: { "sqs-option": 1, none: 0 },
		},
		relation: {
			type: "choice" as const,
			choice: "supports",
			confidence: 0.96,
			probabilities: { supports: 0.96, unrelated: 0.04 },
		},
		planning_substance: { type: "noul" as const, noul: 0.87 },
		support: { type: "noul" as const, noul: 0.86 },
		duplicate: { type: "noul" as const, noul: 0.12 },
	};
	let triage = {
		...first({ reason: 0.91, c0_owned_unretracted: 0.94 }),
		thread_target: {
			type: "choice" as const,
			choice: "queue-thread",
			confidence: 0.8,
			probabilities: { "queue-thread": 0.87, none: 0.13 },
		},
		significance: { type: "score" as const, score: 1.41 },
	};
	let assess = (
		text = current.text,
		candidate = answers as Record<string, any>,
		firstAnswers = triage as Record<string, any>,
	) =>
		planEvents({
			channelId: "channel",
			message: message("sqs-reason", text),
			state,
			first: firstAnswers,
			candidates: [{ quote: text, start: 0, end: text.length, answers: candidate }],
		});
	let accepted = assess();
	expect(accepted.events.map(event => event.type)).toEqual(["reason.added"]);
	expect(accepted.events[0]).toMatchObject({
		threadId: "queue-thread",
		source: { quote: current.text, role: "reason" },
		contribution: { targetId: "sqs-option", relation: "supports" },
	});
	expect(
		assess(current.text, {
			...answers,
			role: {
				...answers.role,
				choice: "support",
				probabilities: { reason: 0.44, support: 0.48, none: 0.08 },
			},
		}).events.map(event => event.type),
	).toEqual(["reason.added"]);
	expect(assess(current.text, { ...answers, thread: confidentChoice("none") }).events)
		.toEqual([]);
	expect(
		assess(current.text, answers, {
			...triage,
			thread_target: confidentChoice("none"),
		}).events,
	).toEqual([]);
	expect(
		assess(current.text, answers, {
			...triage,
			c0_owned_unretracted: { type: "noul", noul: 0.3 },
		}).events,
	).toEqual([]);
	expect(assess(current.text, { ...answers, option: confidentChoice("none") }).events)
		.toEqual([]);
	expect(assess(current.text, { ...answers, relation: confidentChoice("unrelated") }).events)
		.toEqual([]);
	expect(
		assess(current.text, answers, { ...triage, reason: { type: "noul", noul: 0.4 } })
			.events,
	).toEqual([]);
	expect(
		assess(current.text, answers, {
			...triage,
			significance: { type: "score", score: 0.9 },
		}).events,
	).toEqual([]);
	expect(
		assess(current.text, {
			...answers,
			role: {
				...answers.role,
				probabilities: { reason: 0.36, support: 0.4, option: 0.24 },
			},
		}).events,
	).toEqual([]);
	expect(assess("I prefer SQS.").events).toEqual([]);
});
