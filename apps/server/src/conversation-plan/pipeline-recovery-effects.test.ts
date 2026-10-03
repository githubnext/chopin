import { expect, test } from "bun:test";
import { applyInference, initialState } from "./domain";
import { effectsFor } from "./effects";
import { interpretMessage } from "./interpret";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { mockResult } from "./interpret.test-fixtures";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

test("a distinct new option is still added without claiming an existing card option", () => {
	let { state, threadId, options, linkedCards } = d01LinkedEditorCard();
	let quote = "I'd pick Slate for the spike;";
	let current = message("d01-m6-new", quote, "Mei");
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		linkedCards,
		first: {
			...first({ new_option: 0.95, c0_owned_unretracted: 0.95 }),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(threadId),
		},
		candidates: [{
			quote,
			start: 0,
			end: quote.length,
			answers: {
				...follow({ role: "option", thread: threadId }),
				option: confidentChoice("new"),
				new_option: { type: "noul", noul: 0.95 },
				planning_substance: { type: "noul", noul: 0.95 },
				duplicate: { type: "noul", noul: 0.05 },
			},
		}],
	});
	let added = result.events.filter(event => event.type === "option.added");
	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({
		type: "option.added",
		threadId,
		source: { messageId: current.id, quote, role: "option" },
		contribution: { text: quote, targetId: threadId, authoring: "quoted" },
	});
	let addedOption = added[0];
	if (addedOption?.type !== "option.added") throw new Error("a distinct option was not added");
	expect(options.some(option => option.id === addedOption.contribution.id)).toBe(false);
	expect(state.threads[0]!.contributions.filter(item => item.kind === "option")).toEqual([]);
});

test("an explicit multi-option question opens one thread with its exact quoted options", async () => {
	let recent = [message("figma-purpose", "Okay we gotta figure out what we're doing for auth")];
	let current = message(
		"figma-options",
		"Should we use an off the shelf solution like Auth0? Or roll our own? Or use something like GitHub auth?",
		"Jules",
	);
	let state = initialState();
	let calls = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent,
		state,
		ask: async request =>
			mockResult(
				request.questions,
				calls++ === 0
					? {
						new_question: 0.97,
						act: "question",
						thread_target: "new",
						new_option: 0.96,
						significance: 2,
					}
					: {
						c0_role: "option",
						c0_thread: "new",
						c0_new_option: 0.96,
						c0_duplicate: 0.84,
						c1_role: "option",
						c1_thread: "none",
						c1_new_option: 0.93,
						c2_role: "option",
						c2_thread: "new",
						c2_new_option: 0.96,
					},
			),
	});
	expect(calls).toBe(4);
	expect(output.events.map(event => event.type)).toEqual([
		"thread.opened",
		"option.added",
		"option.added",
		"option.added",
	]);
	let opened = output.events[0]!;
	expect(opened).toMatchObject({
		question: current.text,
		source: { quote: current.text, start: 0, end: current.text.length },
	});
	let quotes = extractQuotes(current.text);
	expect(output.events.slice(1).map(event => "source" in event ? event.source?.quote : ""))
		.toEqual(quotes.map(quote => quote.quote));
	let accepted = output.events.reduce(
		(next, event) => applyInference(next, event, current),
		state,
	);
	expect(effectsFor(output.events, accepted)).toMatchObject([{
		kind: "insert-card",
		options: quotes.map(quote => ({ label: quote.quote })),
	}]);
	let targeting = output.analysis.passes[1]!.answers;
	let replay = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: output.analysis.passes[0]!.answers,
		candidates: quotes.map((quote, index) => ({
			...quote,
			answers: Object.fromEntries(
				Object.entries(targeting)
					.filter(([key]) => key.startsWith(`c${index}_`))
					.map(([key, answer]) => [key.slice(3), answer]),
			),
		})),
	});
	expect(replay.events.map(event => event.id)).toEqual(output.events.map(event => event.id));
	let duplicate = replay.events.reduce(
		(next, event) => applyInference(next, event, current),
		accepted,
	);
	expect(duplicate.events).toEqual(accepted.events);
});
