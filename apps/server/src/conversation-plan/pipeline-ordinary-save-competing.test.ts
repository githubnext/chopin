import { expect, test } from "bun:test";
import { applyInference } from "./domain";
import { extractQuotes } from "./quotes";
import { message } from "./policy-initial.test-fixtures";
import {
	emailState,
	knownChoiceAnswers,
	mockInterpret,
	newChoiceAnswers,
	proposalTriage,
} from "./pipeline-ordinary-save.test-fixtures";
import { queueWithPendingSave } from "./pipeline-ordinary-save-pending.test-fixtures";

// Whole archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2 pipeline.test.ts callbacks.
test("distinct new choices for one thread add sourced options without choosing between them", async () => {
	let current = message(
		"competing-same-thread",
		"We should use Postmark for notification emails. We should use Amazon SES for notification emails.",
	);
	let quotes = extractQuotes(current.text);
	let output = await mockInterpret(
		current,
		emailState(),
		proposalTriage("email-thread"),
		prefix => newChoiceAnswers(prefix, "email-thread"),
	);
	expect(output.events.map(event => event.type)).toEqual(["option.added", "option.added"]);
	expect(output.events.map(event => event.type === "option.added" ? event.source?.quote : ""))
		.toEqual(quotes.map(item => item.quote));
	for (let [index, quote] of quotes.entries()) {
		expect(output.events[index]).toMatchObject({
			threadId: "email-thread",
			contribution: { text: quote.quote },
			source: { quote: quote.quote, start: quote.start, end: quote.end, role: "option" },
		});
	}
	expect(output.analysis.outcomes?.[1]).toMatchObject({
		start: quotes[1]!.start,
		end: quotes[1]!.end,
		status: "review",
	});
});

test("a pending Save survives later competing known and new choices", async () => {
	let { state, proposal } = queueWithPendingSave();
	for (
		let item of [
			{
				id: "later-known-choice",
				text: "I think we should use the PostgreSQL queue.",
				newChoice: false,
				optionId: "postgres-option",
			},
			{
				id: "later-new-choice",
				text: "We should use BullMQ for background jobs.",
				newChoice: true,
				optionId: "new",
			},
		] as const
	) {
		let current = message(item.id, item.text, "Omar");
		let triage = proposalTriage("queue-thread", "proposal", {
			new_option: item.newChoice ? 0.98 : 0.1,
		});
		let output = await mockInterpret(
			current,
			state,
			triage,
			prefix =>
				item.newChoice
					? newChoiceAnswers(prefix, "queue-thread")
					: knownChoiceAnswers(prefix, "queue-thread", item.optionId),
		);
		expect(output.events).toEqual([]);
		expect(output.analysis.outcomes?.[0]).toMatchObject({
			start: 0,
			end: current.text.length,
			status: "review",
		});
		let next = output.events.reduce(
			(currentState, event) => applyInference(currentState, event, current),
			state,
		);
		expect(next.threads.find(thread => thread.id === "queue-thread")?.pendingSettle)
			.toEqual({ optionId: "sqs-option", proposer: "Mina", messageId: proposal.id });
	}
});

test("repeating the same new choice twice opens one Save suggestion", async () => {
	let text = "We should use Postmark for notification emails.";
	let current = message("repeat-same-choice", `${text} ${text}`);
	let quotes = extractQuotes(current.text);
	let output = await mockInterpret(
		current,
		emailState(),
		proposalTriage("email-thread"),
		prefix => newChoiceAnswers(prefix, "email-thread"),
	);
	expect(quotes.map(item => item.quote)).toEqual([text, text]);
	expect(output.events.map(event => event.type)).toEqual(["option.added", "settle.suggested"]);
	let added = output.events[0];
	let selectedSource = added && "source" in added ? added.source : undefined;
	expect(added).toMatchObject({
		type: "option.added",
		threadId: "email-thread",
		contribution: { text },
	});
	expect(
		quotes.some(quote =>
			quote.start === selectedSource?.start && quote.end === selectedSource?.end
			&& quote.quote === selectedSource?.quote
		),
	).toBe(true);
	expect(output.events[1]).toMatchObject({
		type: "settle.suggested",
		optionId: added?.type === "option.added" ? added.contribution.id : undefined,
		source: {
			quote: selectedSource?.quote,
			start: selectedSource?.start,
			end: selectedSource?.end,
			role: "resolution",
		},
	});
});
