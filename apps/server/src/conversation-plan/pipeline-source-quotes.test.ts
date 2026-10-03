import { expect, test } from "bun:test";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { message } from "./policy-initial.test-fixtures";

test("extracts two exact clauses with UTF-16 offsets", () => {
	let text = "Keep the outline optional; separately, should each repository remember my choice?";
	let quotes = extractQuotes(text);
	expect(quotes).toHaveLength(2);
	for (let quote of quotes) expect(text.slice(quote.start, quote.end)).toBe(quote.quote);
});

test("splits one sentence with two imperative claims into source-bound clauses", () => {
	let text = "Keep setup optional and remember my choice per repository.";
	let quotes = extractQuotes(text);
	expect(quotes.map((item) => item.quote)).toEqual([
		"Keep setup optional",
		"remember my choice per repository.",
	]);
	for (let quote of quotes) expect(text.slice(quote.start, quote.end)).toBe(quote.quote);
});

test("splits short assent from an and-keep condition with exact offsets", () => {
	let text = "yes, and keep managed hosting as the escape hatch if on-call gets silly";
	let quotes = extractQuotes(text);
	expect(quotes.map(item => item.quote)).toEqual([
		"yes,",
		"keep managed hosting as the escape hatch if on-call gets silly",
	]);
	for (let quote of quotes) expect(text.slice(quote.start, quote.end)).toBe(quote.quote);
	expect(quotes[1]!.start).toBe(text.indexOf("keep"));
});

test.each(
	[
		[
			"reported library choice",
			"We could do tiptap or prosemirror or lexical for text string handling.",
			["tiptap", "prosemirror", "lexical"],
		],
		[
			"held-out storage choice",
			"We could use SQLite, Postgres, or DynamoDB for storing drafts.",
			["SQLite", "Postgres", "DynamoDB"],
		],
		[
			"named topic",
			"By agent access I mean Copilot or a hosted gateway or bring-your-own API keys.",
			["Copilot", "a hosted gateway", "bring-your-own API keys"],
		],
	] as const,
)("extracts atomic, exact alternatives from %s", (_, text, labels) => {
	let current = message("three-way", text);
	let quotes = extractQuotes(text);
	expect(quotes.map(item => item.quote)).toEqual([...labels]);
	for (let quote of quotes) expect(text.slice(quote.start, quote.end)).toBe(quote.quote);
	let triage = buildTriageRequest(current, [], [], quotes);
	let state = triage.state as {
		current: { text: string };
		candidates: Array<{ quote: string; start: number; end: number }>;
	};
	expect(state.current.text).toBe(text);
	expect(state.candidates).toEqual(quotes);
	for (let index = 0; index < quotes.length; index++) {
		let targeting = buildCandidateTargetingRequest(current, [], [], quotes, index).state as {
			current: { text: string };
			preceding: string;
		};
		expect(targeting.current.text).toBe(quotes[index]!.quote);
		expect(targeting.preceding).toBe(text.slice(0, quotes[index]!.start));
	}
});

test("extracts D03's three provider alternatives as exact UTF-16 spans", () => {
	let text = "what sends transactional notifications? our SMTP relay, Postmark, or SES?";
	expect(extractQuotes(text)).toEqual([
		{ quote: "SMTP relay", start: 44, end: 54 },
		{ quote: "Postmark", start: 56, end: 64 },
		{ quote: "SES", start: 69, end: 72 },
	]);
});

test.each([
	"what sends transactional notifications when configured? our SMTP relay, Postmark, or SES?",
	"what sends transactional notifications as a fallback? our SMTP relay, Postmark, or SES?",
])("keeps qualified question text together for review: %s", text => {
	expect(extractQuotes(text).map(({ quote }) => quote)).toEqual([
		text.slice(0, text.indexOf("?") + 1),
		text.slice(text.indexOf("?") + 2),
	]);
});

test.each([
	"We could use a cache or logs or metrics and improve visibility.",
	"The report says we could use SQLite or Postgres or DynamoDB for drafts.",
	'We could use "SQLite or Postgres or DynamoDB" for drafts.',
	"We could use SQLite or Postgres or DynamoDB, but none has been approved.",
	"We could use SQLite or Postgres or DynamoDB but none has been approved.",
	"We could use SQLite or Postgres or DynamoDB none has been approved.",
	"We could use SQLite or Postgres or DynamoDB or Redis for drafts.",
	"We could use SQLite or SQLite or DynamoDB for drafts.",
])("does not split an unsafe or non-atomic list: %s", text => {
	expect(extractQuotes(text)).toHaveLength(1);
});

test("keeps an unpunctuated contrastive suffix out of option sources", () => {
	let text = "We could use SQLite or Postgres or DynamoDB but none has been approved.";
	expect(extractQuotes(text)).toEqual([{ quote: text, start: 0, end: text.length }]);
});

test.each([
	"We could use SQLite or Postgres or DynamoDB because latency matters.",
	"We could use SQLite or Postgres or DynamoDB since latency matters.",
	"We could use SQLite or Postgres or DynamoDB as latency matters.",
	"We could use SQLite or Postgres or DynamoDB for storing drafts because latency matters.",
])("keeps shared rationale out of the last alternative: %s", text => {
	expect(extractQuotes(text)).toEqual([{ quote: text, start: 0, end: text.length }]);
});
