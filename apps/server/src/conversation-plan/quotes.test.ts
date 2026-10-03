import { expect, test } from "bun:test";
import { fixtureMessage } from "./quotes.test-fixtures";
import { extractQuotes } from "./quotes";

test("D19 m1 yields two exact independent question spans", async () => {
	let m1 = await fixtureMessage("D19", "m1");
	let m1Quotes = extractQuotes(m1);

	/*
	 * Before the fix m1 was one span [0,119). The fallback only splits sentence
	 * punctuation and a small imperative-oriented "and" boundary, so it misses
	 * the two independent question topics joined by "and how".
	 */
	expect(m1Quotes).toEqual([
		{ quote: "how people sign in", start: 47, end: 65 },
		{ quote: "how the hosted agent gets repository credentials", start: 70, end: 118 },
	]);
	for (let quote of m1Quotes) {
		expect(m1.slice(quote.start, quote.end)).toBe(quote.quote);
	}
});

test("D19 m2 yields four exact atomic alternatives instead of bundled clauses", async () => {
	let m2 = await fixtureMessage("D19", "m2");
	let m2Quotes = extractQuotes(m2);
	/*
	 * Before the fix m2 was [0,69), [70,207), and [208,238): both "or" lists
	 * stayed bundled and the closing explanation became an unrelated candidate.
	 */
	expect(m2Quotes).toEqual([
		{ quote: "GitHub OAuth", start: 35, end: 47 },
		{ quote: "email magic links", start: 51, end: 68 },
		{ quote: "each user's GitHub token", start: 143, end: 167 },
		{ quote: "GitHub App installation token", start: 177, end: 206 },
	]);
	for (let quote of m2Quotes) {
		expect(m2.slice(quote.start, quote.end)).toBe(quote.quote);
		expect(quote.quote).not.toMatch(/\bor\b/i);
	}
});

test("keeps current D02-D04 exact extraction controls", async () => {
	let d02 = await fixtureMessage("D02", "m2");
	let d03 = await fixtureMessage("D03", "m1");
	let d04 = await fixtureMessage("D04", "m5");
	expect(extractQuotes(d02)).toEqual([
		{ quote: "a small VPS is enough for this traffic.", start: 0, end: 39 },
		{ quote: "we'll have to patch it ourselves.", start: 40, end: 73 },
	]);
	expect(extractQuotes(d03)).toEqual([
		{ quote: "SMTP relay", start: 44, end: 54 },
		{ quote: "Postmark", start: 56, end: 64 },
		{ quote: "SES", start: 69, end: 72 },
	]);
	expect(extractQuotes(d04)).toEqual([
		{ quote: "worth comparing.", start: 0, end: 16 },
		{ quote: "R2's egress could matter for thumbnails.", start: 17, end: 57 },
	]);
});

test("does not split a compound option name or quoted/rejected alternatives", () => {
	let compound =
		"We could use the Selection and Range APIs, CodeMirror, or our own document model.";
	let quoted =
		'The note says, "Use GitHub OAuth or email magic links," but that option was rejected.';
	let rejected =
		"We could use GitHub OAuth or email magic links, but the team rejected both options.";
	for (let text of [compound, quoted, rejected]) {
		expect(extractQuotes(text)).toEqual([{ quote: text, start: 0, end: text.length }]);
	}
});

test("quote extraction accepts four candidates and rejects a fifth without truncation", () => {
	expect(extractQuotes("First. Second. Third. Fourth.")).toEqual([
		{ quote: "First.", start: 0, end: 6 },
		{ quote: "Second.", start: 7, end: 14 },
		{ quote: "Third.", start: 15, end: 21 },
		{ quote: "Fourth.", start: 22, end: 29 },
	]);
	expect(() => extractQuotes("First. Second. Third. Fourth. Fifth."))
		.toThrow("source quote count exceeds 4");
});

test.each(
	[
		[
			"Which queue fits our launch? Redis, SQS, Postgres, or a small in-process queue with disk replay.",
			["Redis", "SQS", "Postgres", "a small in-process queue with disk replay"],
		],
		[
			"Cedar, Elm, Ash, or browser Selection and Range with a custom model.",
			["Cedar", "Elm", "Ash", "browser Selection and Range with a custom model"],
		],
		["Redis, SQS, or Postgres.", ["Redis", "SQS", "Postgres"]],
	] as const,
)("extracts bounded alternatives without domain vocabulary: %s", (text, labels) => {
	let quotes = extractQuotes(text);
	expect(quotes.map(item => item.quote)).toEqual([...labels]);
	for (let quote of quotes) expect(text.slice(quote.start, quote.end)).toBe(quote.quote);
});

test("a fifth explicit alternative fails the budget rather than becoming one sentence", () => {
	expect(() => extractQuotes("Cedar, Elm, Ash, Pine, or Oak.")).toThrow(
		"source quote count exceeds 4",
	);
});
