import { expect, test } from "bun:test";
import type { JevAnswer } from "./jev";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { stateWithOption, terminalPolicy as planEvents } from "./policy-terminal.test-fixtures";
import { extractQuotes } from "./quotes";

// Preserved from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
test("captures two sourced options from an owned declarative explanation of an open topic", () => {
	let state = stateWithOption(
		"How should we provide agent access?",
		"access-thread",
		"existing-access",
		"Use a hosted gateway.",
	);
	let current = message(
		"access-alternatives",
		"By agent access I mean Copilot or bring-your-own API keys.",
	);
	let quotes = extractQuotes(current.text);
	expect(quotes).toEqual([
		{ quote: "Copilot", start: 23, end: 30 },
		{ quote: "bring-your-own API keys", start: 34, end: 57 },
	]);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.93 }),
			thread_target: confidentChoice("access-thread"),
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "none", thread: "access-thread" }),
				new_option: { type: "noul", noul: 0.05 },
				duplicate: { type: "noul", noul: 0.04 },
			},
		})),
	});
	expect(output.events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(output.events.map(event => event.type === "option.added" && event.contribution.text))
		.toEqual(quotes.map(quote => quote.quote));
	expect(output.events.map(event => "source" in event && event.source)).toMatchObject(
		quotes.map(quote => ({ ...quote, role: "option" })),
	);
	expect(output.events.some(event =>
		event.type === "settle.suggested"
		|| event.type === "decision.recorded"
	)).toBe(false);
});
test("recovers a declarative pair when the whole-message target resolves one weaker span", () => {
	let state = stateWithOption(
		"How should we provide agent access?",
		"access-thread",
		"existing-access",
		"Use a hosted gateway.",
	);
	let current = message(
		"observed-access-pair",
		"By agent access I mean Copilot or bring-your-own API keys.",
	);
	let quotes = extractQuotes(current.text);
	let triage = {
		...first({
			new_option: 0.93,
			c0_owned_unretracted: 0.79,
			c1_owned_unretracted: 0.86,
		}),
		thread_target: {
			type: "choice" as const,
			choice: "access-thread",
			confidence: 0.98,
			probabilities: { "access-thread": 0.98, none: 0.02 },
		},
	};
	let candidates: Parameters<typeof planEvents>[0]["candidates"] = quotes.map((quote, index) => {
		let thread: JevAnswer = index
			? {
				type: "choice" as const,
				choice: "access-thread",
				confidence: 0.96,
				probabilities: { "access-thread": 0.98, none: 0.02 },
			}
			: {
				type: "choice" as const,
				choice: "access-thread",
				confidence: 0.45,
				probabilities: { "access-thread": 0.59, none: 0.29, other: 0.09, new: 0.03 },
			};
		return {
			...quote,
			answers: {
				...follow({ role: index ? "option" : "none", thread: "access-thread" }),
				thread,
				new_option: { type: "noul" as const, noul: index ? 0.86 : 0.4 },
				duplicate: { type: "noul" as const, noul: index ? 0.13 : 0.37 },
			},
		};
	});
	let assess = (
		firstAnswers = triage as Record<string, any>,
		candidateAnswers = candidates,
	) =>
		planEvents({
			channelId: "channel",
			message: current,
			state,
			first: firstAnswers,
			candidates: candidateAnswers,
		});
	expect(assess().events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(assess().events.map(event => "source" in event && event.source)).toMatchObject(
		quotes.map(quote => ({ ...quote, role: "option" })),
	);
	expect(
		assess({
			...triage,
			thread_target: {
				...triage.thread_target,
				probabilities: { "access-thread": 0.84, none: 0.16 },
			},
		}).events,
	).toEqual([]);
	expect(
		assess(triage, [{
			...candidates[0]!,
			answers: {
				...candidates[0]!.answers,
				thread: {
					type: "choice",
					choice: "access-thread",
					confidence: 0.35,
					probabilities: { "access-thread": 0.52, none: 0.4, other: 0.08 },
				},
			},
		}, candidates[1]!]).events,
	).toEqual([]);
	expect(
		assess(triage, [candidates[0]!, {
			...candidates[1]!,
			answers: { ...candidates[1]!.answers, thread: candidates[0]!.answers.thread },
		}]).events,
	).toEqual([]);
	expect(
		assess(triage, [{
			...candidates[0]!,
			answers: {
				...candidates[0]!.answers,
				duplicate: { type: "noul", noul: 0.72 },
			},
		}, candidates[1]!]).events,
	).toEqual([]);
});
test("a definition of CI failure causes needs review without option evidence", () => {
	let state = stateWithOption(
		"How should we improve CI reliability?",
		"quality-thread",
		"existing-quality",
		"Retry failed jobs automatically.",
	);
	let current = message(
		"observed-definition",
		"By CI reliability I mean flaky tests or missing dependencies.",
	);
	let quotes = extractQuotes(current.text);
	expect(quotes).toEqual([
		{ quote: "flaky tests", start: 25, end: 36 },
		{ quote: "missing dependencies", start: 40, end: 60 },
	]);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ c0_owned_unretracted: 0.94, c1_owned_unretracted: 0.95 }),
			new_option: { type: "noul", noul: 0.59 },
			thread_target: {
				type: "choice",
				choice: "quality-thread",
				confidence: 0.84,
				probabilities: { "quality-thread": 0.84, none: 0.16 },
			},
			significance: {
				type: "score",
				score: 1.47,
				confidence: 0.5,
				legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "changes work" },
				probabilities: { "0": 0.2, "1": 0.2, "2": 0.53, "3": 0.07 },
			},
		},
		candidates: quotes.map((quote, index) => ({
			...quote,
			answers: {
				...follow({ role: index ? "none" : "reason", thread: "quality-thread" }),
				role: index
					? {
						type: "choice" as const,
						choice: "none",
						confidence: 0.38,
						probabilities: { none: 0.38, reason: 0.35, option: 0.27 },
					}
					: {
						type: "choice" as const,
						choice: "reason",
						confidence: 0.45,
						probabilities: { reason: 0.45, none: 0.39, option: 0.16 },
					},
				thread: {
					type: "choice" as const,
					choice: "quality-thread",
					confidence: index ? 0.84 : 0.99,
					probabilities: { "quality-thread": index ? 0.84 : 0.99, none: index ? 0.16 : 0.01 },
				},
				new_option: { type: "noul" as const, noul: index ? 0.11 : 0.16 },
				duplicate: { type: "noul" as const, noul: index ? 0.18 : 0.23 },
			},
		})),
	});
	expect(output.events).toEqual([]);
	expect(output.policyGate).toBe("declarative options need review");
});
