import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference, initialState } from "./domain";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import type { PolicyInput } from "./policy-types";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";
import { planEvents } from "./policy";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { MAX_EVENTS } from "./validation";

// Preserved from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2,
// apps/server/src/conversation-plan/pipeline.test.ts.
test("D01's bare editor list adds four exact options to its uniquely open thread", () => {
	let opening = d01RecordedOpening();
	let opened = planEvents(opening).events[0]!;
	let state = applyInference(opening.state, opened, opening.message);
	let threadId = state.threads[0]!.id;
	let current = message(
		"d01-m2",
		"Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
		"Nia",
	);
	let quotes = extractQuotes(current.text);
	expect(quotes).toEqual([
		{ quote: "Tiptap", start: 0, end: 6 },
		{ quote: "bare ProseMirror", start: 8, end: 24 },
		{ quote: "Lexical", start: 26, end: 33 },
		{
			quote: "just native Selection and Range with our own document model",
			start: 38,
			end: 97,
		},
	]);
	let triage = buildTriageRequest(current, [], state.threads, quotes);
	expect(triage.questions.c3_owned_unretracted?.type).toBe("noul");
	let fourth = buildCandidateTargetingRequest(current, [], state.threads, quotes, 3);
	expect(fourth.questions.c3_role?.type).toBe("choice");
	expect((fourth.state as { current: { text: string } }).current.text).toBe(quotes[3]!.quote);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({
				new_option: 0.95,
				c3_owned_unretracted: 0.95,
			}),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(threadId),
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "option", thread: threadId }),
				option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.95 },
				duplicate: { type: "noul", noul: 0.05 },
			},
		})),
	});
	expect(output.events.map(event => event.type)).toEqual(Array(4).fill("option.added"));
	expect(output.events.map(event => event.type === "option.added" && event.threadId))
		.toEqual(Array(4).fill(threadId));
	expect(output.events.map(event => event.type === "option.added" && event.contribution.text))
		.toEqual(quotes.map(quote => quote.quote));
	expect(output.events.map(event => "source" in event && event.source)).toMatchObject(
		quotes.map(quote => ({ ...quote, messageId: current.id, role: "option" })),
	);
	expect(
		new Set(output.events.map(event => event.type === "option.added" && event.contribution.id))
			.size,
	).toBe(4);
});
test("D01's bare list cannot create options without one identifiable open thread", () => {
	let opening = d01RecordedOpening();
	let editor = applyInference(opening.state, planEvents(opening).events[0]!, opening.message);
	let another = message("other-question", "Which database should we use?", "Nia");
	let ambiguous = applyInference(editor, {
		id: "other-thread-event",
		type: "thread.opened",
		threadId: "other-thread",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: another.ts,
		source: {
			messageId: another.id,
			author: another.author as ConversationPlan.SourceAuthor,
			quote: another.text,
			start: 0,
			end: another.text.length,
			role: "question",
		},
		question: another.text,
	}, another);
	let current = message(
		"d01-m2-untargeted",
		"Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
		"Nia",
	);
	let spans = [[0, 6], [8, 24], [26, 33], [38, 97]];
	let candidates: PolicyInput["candidates"] = spans.map(([start, end]) => ({
		quote: current.text.slice(start!, end!),
		start: start!,
		end: end!,
		answers: {
			...follow({ role: "option", thread: "none", threadProbability: 0.55 }),
			new_option: { type: "noul", noul: 0.95 },
			duplicate: { type: "noul", noul: 0.05 },
		},
	}));
	let firstPass = {
		...first({ new_option: 0.95, c3_owned_unretracted: 0.95 }),
		act: confidentChoice("proposal"),
		thread_target: {
			type: "choice" as const,
			choice: "none",
			confidence: 0.5,
			probabilities: { none: 0.5, [editor.threads[0]!.id]: 0.25, "other-thread": 0.25 },
		},
	};
	for (let state of [initialState(), ambiguous]) {
		expect(
			planEvents({
				channelId: "channel",
				message: current,
				state,
				first: firstPass,
				candidates,
			}).events,
		).toEqual([]);
	}
});

test("an unrelated four-option list requires every option to be well supported", () => {
	let opening = d01RecordedOpening();
	let state = applyInference(opening.state, planEvents(opening).events[0]!, opening.message);
	let threadId = state.threads[0]!.id;
	state.threads[0]!.question = "Which launch queue should we use?";
	let current = message(
		"queue-options",
		"Redis, SQS, Postgres, or a small in-process queue with disk replay.",
		"Nia",
	);
	let quotes = extractQuotes(current.text);
	let input: PolicyInput = {
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.95, c3_owned_unretracted: 0.95 }),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(threadId),
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "option", thread: threadId }),
				option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.95 },
				duplicate: { type: "noul", noul: 0.05 },
			},
		})),
	};
	expect(planEvents(input).events.map(event => event.type)).toEqual(Array(4).fill("option.added"));
	let three = message("queue-options-three", "Redis, SQS, or Postgres.", "Nia");
	let threeQuotes = extractQuotes(three.text);
	expect(threeQuotes).toHaveLength(3);
	expect(
		planEvents({
			...input,
			message: three,
			candidates: threeQuotes.map((quote, index) => ({
				...quote,
				answers: input.candidates[index]!.answers,
			})),
		}).events.map(event => event.type),
	).toEqual(Array(3).fill("option.added"));
	let capped = structuredClone(input);
	let openingEvent = capped.state.events[0]!;
	capped.state.events = Array.from({ length: MAX_EVENTS - 1 }, (_, index) => ({
		...openingEvent,
		id: `historical-${index}`,
	}));
	expect(planEvents(capped).events).toEqual([]);
	input.candidates[1]!.answers.duplicate = { type: "noul", noul: 0.9 };
	expect(planEvents(input).events).toEqual([]);
});

test("an explicit list near the contribution limit does not add only its first option", () => {
	let opening = d01RecordedOpening();
	let state = applyInference(opening.state, planEvents(opening).events[0]!, opening.message);
	let thread = state.threads[0]!;
	let seed = message("prior-options", "An earlier alternative.", "Nia");
	for (let index = 0; index < 63; index++) {
		state = applyInference(state, {
			id: `prior-option-event-${index}`,
			type: "option.added",
			threadId: thread.id,
			observedThreadVersion: state.threads[0]!.version,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: seed.ts,
			source: {
				messageId: seed.id,
				author: seed.author as ConversationPlan.SourceAuthor,
				quote: seed.text,
				start: 0,
				end: seed.text.length,
				role: "option",
			},
			contribution: {
				id: `prior-contribution-${index}`,
				text: seed.text,
				authoring: "quoted",
			},
		}, seed);
	}
	let current = message("capacity-list", "Redis, SQS, Postgres, or SQLite.", "Nia");
	let quotes = extractQuotes(current.text);
	let input: PolicyInput = {
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ new_option: 0.95, c3_owned_unretracted: 0.95 }),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(thread.id),
		},
		candidates: quotes.map(quote => ({
			...quote,
			answers: {
				...follow({ role: "option", thread: thread.id }),
				option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.95 },
				duplicate: { type: "noul", noul: 0.05 },
			},
		})),
	};
	let output = planEvents(input);
	expect(output.events).toEqual([]);
	expect(output.outcomes).toHaveLength(4);
	expect(output.outcomes.every(outcome => outcome.status === "review")).toBe(true);
});
