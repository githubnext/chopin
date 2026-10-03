import { expect, test } from "bun:test";
import { message } from "./policy-initial.test-fixtures";
import { addThreadWithOption, stateWithOption } from "./policy-terminal.test-fixtures";
import {
	emailState,
	knownChoiceAnswers,
	mockInterpret,
	newChoiceAnswers,
	proposalTriage,
} from "./pipeline-ordinary-save.test-fixtures";

test("weak, hedged, negative, reported, duplicate, and list wording cannot preselect", async () => {
	for (
		let item of [
			{ id: "postmark-guess", text: "We should use Postmark for emails, I guess.", empty: false },
			{
				id: "postmark-probably",
				text: "We should use Postmark for emails, probably.",
				empty: false,
			},
			{
				id: "hedged-new-choice",
				text: "Maybe we should use Postmark for notification emails.",
				empty: true,
			},
			{
				id: "negated-new-choice",
				text: "We should not use Postmark for notification emails.",
				empty: true,
			},
			{
				id: "reported-new-choice",
				text: "Alice said we should use Postmark for notification emails.",
				empty: true,
			},
			{
				id: "duplicate-new-choice",
				text: "We should use Mailgun for notification emails.",
				empty: true,
			},
			{
				id: "plain-option-list",
				text: "Postmark or Amazon SES for notification emails.",
				empty: false,
			},
		] as const
	) {
		let current = message(item.id, item.text);
		let duplicate = item.id === "duplicate-new-choice" ? 0.96 : 0.04;
		let output = await mockInterpret(
			current,
			emailState(),
			proposalTriage("email-thread", "proposal", { duplicate }),
			prefix =>
				newChoiceAnswers(prefix, "email-thread", {
					role: item.id === "plain-option-list" ? "option" : "resolution",
					duplicate,
				}),
		);
		expect(output.events.some(event => event.type === "settle.suggested")).toBe(false);
		expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
		if (item.empty) expect(output.events).toEqual([]);
	}
});

test("ambiguous thread targeting cannot settle a direct new choice", async () => {
	let state = emailState();
	state = addThreadWithOption(
		state,
		"other-email-thread",
		"Should we use a different email provider?",
		"existing-ses",
		"Use Amazon SES.",
	);
	let current = message(
		"ambiguous-new-choice",
		"We should use Postmark for notification emails.",
	);
	let output = await mockInterpret(
		current,
		state,
		proposalTriage("none"),
		prefix => newChoiceAnswers(prefix, "none"),
		(result, prefix) => {
			if (!prefix) return;
			let target = result.answers[`${prefix}_thread`];
			target.choice = "none";
			target.confidence = 0.5;
			target.probabilities = { "email-thread": 0.47, "other-email-thread": 0.46, none: 0.07 };
		},
	);
	expect(output.events).toEqual([]);
});

test("I think we should use a known option suggests Save, not a decision", async () => {
	let current = message("existing-option-recommendation", "I think we should use SQS.");
	let state = stateWithOption(
		"Which queue should handle background jobs?",
		"queue-thread",
		"sqs-option",
		"Use SQS.",
	);
	let output = await mockInterpret(
		current,
		state,
		proposalTriage("queue-thread", "proposal", { new_option: 0.1 }),
		prefix => knownChoiceAnswers(prefix, "queue-thread", "sqs-option", "support"),
	);
	expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({
		threadId: "queue-thread",
		optionId: "sqs-option",
		source: { quote: current.text, start: 0, end: current.text.length, role: "resolution" },
	});
	expect(output.events.some(event => event.type === "option.added")).toBe(false);
	expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
});
