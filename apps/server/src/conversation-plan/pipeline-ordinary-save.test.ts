import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { addThreadWithOption } from "./policy-terminal.test-fixtures";
import {
	emailState,
	expectSourcedOptionSave,
	mockInterpret,
	newChoiceAnswers,
	optionChoice,
	proposalTriage,
} from "./pipeline-ordinary-save.test-fixtures";

// Whole archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 pipeline.test.ts callbacks.
test("a known choice becomes a settle suggestion, never a decision", () => {
	let current = message("m2", "Let's just go with the optional outline.");
	let state = withOption(seeded());
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.98 }),
		candidates: [
			{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
					chosen_option: optionChoice(seededOptionId),
				},
			},
		],
	});
	expect(output.events.map((event) => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({ optionId: seededOptionId });
	expect("source" in output.events[0] ? output.events[0].source?.quote : undefined).toBe(
		current.text,
	);
	expect(state.threads[0].status).toBe("exploring");
	let ambiguous = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.98 }),
		candidates: [
			{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({
						role: "resolution",
						thread: "thread-a",
						threadProbability: 0.65,
						explicit_resolution: 0.98,
					}),
					chosen_option: optionChoice(seededOptionId),
				},
			},
		],
	});
	expect(ambiguous.events).toEqual([]);
});

test.each(
	[
		{
			id: "new-postmark-choice",
			text: "We should use Postmark for notification emails.",
			act: "proposal",
		},
		{
			id: "new-postmark-commitment",
			text: "Let's do Postmark for notification emails.",
			act: "commitment",
		},
		{
			id: "new-postmark-decided-choice",
			text: "We've decided to use Postmark for notification emails.",
			act: "commitment",
		},
	] as const,
)("a new choice in $act text stages it and suggests Save", async ({ id, text, act }) => {
	let current = message(id, text);
	let state = emailState();
	let quote = extractQuotes(text)[0]!;
	let output = await mockInterpret(
		current,
		state,
		proposalTriage("email-thread", act, { explicit_resolution: 0.94 }),
		prefix => newChoiceAnswers(prefix, "email-thread", { explicit_resolution: 0.94 }),
	);
	expectSourcedOptionSave(output.events, "email-thread", quote);
	expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
});

test("direct choices for distinct threads both suggest Save", async () => {
	let current = message(
		"two-thread-proposals",
		"We should use Postmark for notifications. We should use Redis for background jobs.",
	);
	let state = emailState();
	state = addThreadWithOption(
		state,
		"jobs-thread",
		"Should background jobs use Redis or a PostgreSQL queue?",
		"existing-postgres-queue",
		"Use a PostgreSQL queue.",
	);
	let quotes = extractQuotes(current.text);
	let output = await mockInterpret(
		current,
		state,
		proposalTriage("none"),
		prefix => newChoiceAnswers(prefix, prefix === "c0" ? "email-thread" : "jobs-thread"),
	);
	expect(output.events.map(event => event.type)).toEqual([
		"option.added",
		"settle.suggested",
		"option.added",
		"settle.suggested",
	]);
	for (let [index, quote] of quotes.entries()) {
		expectSourcedOptionSave(
			output.events.slice(index * 2, index * 2 + 2),
			index === 0 ? "email-thread" : "jobs-thread",
			quote,
		);
	}
	expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
});
