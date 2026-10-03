import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, settledBy, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";
import { discarded } from "./pipeline-lifecycle.test-fixtures";

test("a new option remains visible when its wording also sounds like a resolution", () => {
	let state = withOption(seeded());
	let current = message(
		"new-access-path",
		"I guess both. Let's do no harness, just lightweight stuff with API keys for now.",
	);
	let quote = "Let's do no harness, just lightweight stuff with API keys for now.";
	let start = current.text.indexOf(quote);
	let answers = {
		...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.8 }),
		role: {
			type: "choice" as const,
			choice: "resolution",
			confidence: 0.44,
			probabilities: { resolution: 0.49, option: 0.42, none: 0.09 },
		},
		chosen_option: optionChoice("new"),
		new_option: { type: "noul" as const, noul: 0.91 },
		planning_substance: { type: "noul" as const, noul: 0.88 },
		duplicate: { type: "noul" as const, noul: 0.11 },
	};
	let triage = {
		...first({ new_option: 0.86, explicit_resolution: 0.72 }),
		significance: {
			type: "score" as const,
			score: 2.86,
			confidence: 0.87,
			legend: { "0": "chatter", "1": "minor", "2": "useful", "3": "work" },
			probabilities: { "0": 0, "1": 0, "2": 0.14, "3": 0.86 },
		},
	};
	let assess = (
		candidateAnswers = answers as Record<string, any>,
		firstAnswers = triage as Record<string, any>,
		candidateState = state,
	) =>
		planEvents({
			channelId: "channel",
			message: current,
			state: candidateState,
			first: firstAnswers,
			candidates: [{ quote, start, end: start + quote.length, answers: candidateAnswers }],
		});
	let accepted = assess();
	expect(accepted.events.map((event) => event.type)).toEqual(["option.added"]);
	expect(accepted.events[0]).toMatchObject({
		threadId: "thread-a",
		source: { quote, start, end: start + quote.length, role: "option" },
		contribution: { text: quote, targetId: "thread-a" },
	});
	expect(accepted.events.some((event) => event.type === "settle.suggested")).toBe(false);
	expect(assess({ ...answers, chosen_option: optionChoice(seededOptionId) }).events)
		.toEqual([]);
	expect(assess({ ...answers, new_option: { type: "noul", noul: 0.6 } }).events)
		.toEqual([]);
	expect(assess({ ...answers, duplicate: { type: "noul", noul: 0.9 } }).events)
		.toEqual([]);
	expect(assess(answers, { ...triage, new_option: { type: "noul", noul: 0.6 } }).events)
		.toEqual([]);
	expect(assess(answers, { ...triage, c0_owned_unretracted: { type: "noul", noul: 0.3 } }).events)
		.toEqual([]);
	expect(assess({ ...answers, thread: optionChoice("none") }).events).toEqual([]);
	expect(assess(answers, triage, discarded(state)).events).toEqual([]);
});

test("one message can agree with a pending choice and open a separate sourced question", () => {
	let current = message(
		"combined",
		"Sounds good to me. What about agent access? Copilot? BYO API keys?",
		"alice",
	);
	let state = settledBy(seeded(), "bob");
	let quotes = extractQuotes(current.text);
	let candidates = quotes.map((quote, index) => ({
		...quote,
		answers: index === 0
			? {
				...follow({ role: "support", thread: "thread-a" }),
				support: { type: "noul" as const, noul: 0.8 },
				agrees_with_settle: { type: "noul" as const, noul: 0.8 },
			}
			: index === 1
			? follow({ role: "question", thread: "new" })
			: follow({ role: "none", thread: "none" }),
	}));
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ new_question: 0.95, support: 0.9 }),
		candidates,
	});
	expect(result.events.map(event => event.type)).toEqual([
		"stance.changed",
		"settle.agreed",
		"thread.opened",
	]);
	expect(result.events.filter(event => event.type === "decision.recorded")).toEqual([]);
	expect(result.events.map(event => "source" in event ? event.source?.quote : undefined))
		.toEqual([quotes[0]?.quote, quotes[0]?.quote, quotes[1]?.quote]);
	let uncertain = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ new_question: 0.95, support: 0.9 }),
		candidates: [{
			...candidates[0]!,
			answers: {
				...candidates[0]!.answers,
				thread: follow({ role: "support", thread: "none" }).thread,
			},
		}, ...candidates.slice(1)],
	});
	expect(uncertain.events.map(event => event.type)).toEqual(["thread.opened"]);
});
