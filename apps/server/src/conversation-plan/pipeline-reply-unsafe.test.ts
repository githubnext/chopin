import { expect, test } from "bun:test";
import { extractQuotes } from "./quotes";

test.each(
	[
		[
			"capitalized because qualifier",
			"Because this is our fallback, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"capitalized when-configured qualifier",
			"When configured, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"capitalized as-fallback qualifier",
			"As Fallback, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"quoted",
			'what sends transactional notifications? "our SMTP relay, Postmark, or SES?"',
		],
		[
			"reported",
			'Dan said, "what sends transactional notifications? our SMTP relay, Postmark, or SES?"',
		],
		[
			"negated",
			"not what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"conditional",
			"if cost wins, what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"inline conditional qualifier",
			"what sends transactional notifications if cost wins? our SMTP relay, Postmark, or SES?",
		],
		[
			"inline when qualifier",
			"what sends transactional notifications when cost wins? our SMTP relay, Postmark, or SES?",
		],
		[
			"inline topic attribution",
			"what sends transactional notifications according to Dan? our SMTP relay, Postmark, or SES?",
		],
		[
			"reported inline topic",
			"what sends transactional notifications as Dan reported? our SMTP relay, Postmark, or SES?",
		],
		[
			"inline unless qualifier",
			"what sends transactional notifications unless cost wins? our SMTP relay, Postmark, or SES?",
		],
		[
			"reported inline question",
			"Dan said what sends transactional notifications? our SMTP relay, Postmark, or SES?",
		],
		[
			"slash-conjoined providers",
			"what sends transactional notifications? our SMTP relay / Postmark, SES, or Mailgun?",
		],
		[
			"rationale in first item",
			"what sends transactional notifications? our SMTP relay is cheap, Postmark, or SES?",
		],
		[
			"because rationale in first item",
			"what sends transactional notifications? our SMTP relay because cheap, Postmark, or SES?",
		],
		[
			"capitalized because list item",
			"what sends transactional notifications? our SMTP relay, Because, or SES?",
		],
		[
			"capitalized when-configured list item",
			"what sends transactional notifications? our SMTP relay, When configured, or SES?",
		],
		[
			"capitalized as-fallback list item",
			"what sends transactional notifications? our SMTP relay, As Fallback, or SES?",
		],
		[
			"duplicate-item",
			"what sends transactional notifications? our SMTP relay, Postmark, or SMTP relay?",
		],
	] as const,
)("does not split an unsafe D03 provider list into choices", (_, text) => {
	let quotes = extractQuotes(text);
	expect(quotes.some(({ quote }) =>
		[
			"SMTP relay",
			"Postmark",
			"SES",
			"Because",
			"When configured",
			"As Fallback",
		].includes(quote)
	))
		.toBe(false);
});

test.each([
	`Rob said, "Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model."`,
	`"Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model."`,
	"Not Tiptap, bare ProseMirror, Lexical, or just native Selection and Range with our own document model.",
	"Tiptap, bare ProseMirror, Lexical, or Tiptap.",
])("quoted, negated, or duplicate four-option lists stay whole: %s", text => {
	expect(extractQuotes(text)).not.toHaveLength(4);
});

test("a fifth explicit option fails the source budget", () => {
	expect(() =>
		extractQuotes(
			"Tiptap, bare ProseMirror, Lexical, Slate, or just native Selection and Range with our own document model.",
		)
	).toThrow("source quote count exceeds 4");
});
