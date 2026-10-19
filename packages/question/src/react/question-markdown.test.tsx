import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionMarkdownContext } from "./question-markdown";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

import type { ReactNode } from "react";
import type { QuestionMarkdownRenderer } from "./question-markdown";
import type { QuestionViewProps } from "./question-view";

/** Marks what went through which renderer, so placement is visible in the markup. */
const MARKED: QuestionMarkdownRenderer = {
	inline: (source, { links }) => <span data-inline={links ? "links" : "plain"}>{source}</span>,
	block: source => <span data-block="">{source}</span>,
};

const BODY = "- Storage: PostgreSQL\n- Rollout: small pilot";
const QUESTION = `Confirm the earlier answers\n\n${BODY}`;

function render(props: Partial<QuestionViewProps>, renderer?: QuestionMarkdownRenderer): string {
	let view = <QuestionView definition={AUTH} drafts={{}} {...props} />;
	let tree: ReactNode = renderer
		? <QuestionMarkdownContext.Provider value={renderer}>{view}</QuestionMarkdownContext.Provider>
		: view;
	return renderToStaticMarkup(tree);
}

function withQuestion(question: string, extra: object = {}) {
	return { questions: [{ ...AUTH.questions[0]!, question, ...extra }] };
}

test("a plain one-line question renders exactly as it did, with or without a renderer", () => {
	let before = render({});
	expect(before).toContain(">What auth system should we use?</span></h4>");
	expect(before).not.toContain("data-question-markdown");
	let plain = "Use *nix paths, snake_case_names or 2 * 3, then 1. ship?";
	let markup = render({ definition: withQuestion(plain) });
	expect(markup).toContain(`>${plain}</span></h4>`);
	expect(markup).not.toContain("<em>");
	expect(markup).not.toContain("<li>");
});

test("the first line is the heading and the rest renders as Markdown blocks beneath it", () => {
	let markup = render({ definition: withQuestion(QUESTION) }, MARKED);
	let heading = markup.indexOf("Confirm the earlier answers");
	let body = markup.indexOf('data-block="">- Storage');
	expect(heading).toBeGreaterThan(-1);
	expect(markup.slice(markup.indexOf("<h4"), markup.indexOf("</h4>"))).not.toContain("Storage");
	expect(body).toBeGreaterThan(markup.indexOf("</h4>"));
	expect(body).toBeLessThan(markup.indexOf("<fieldset"));
	expect(markup).toContain('class="question-body"');
	// The heading is a link to the related prose only when it has some; unlinked, links work.
	expect(markup).toContain('data-inline="links">Confirm the earlier answers');
});

test("without a renderer the body keeps its lines as plain text", () => {
	let markup = render({ definition: withQuestion(QUESTION) });
	expect(markup).toContain(">Confirm the earlier answers</span></h4>");
	expect(markup).toContain(
		'<div class="question-body" data-question-markdown=""><p class="question-plain-lines">- Storage: PostgreSQL\n- Rollout: small pilot</p></div>',
	);
});

test("descriptions, option labels and option descriptions are Markdown too", () => {
	let definition = {
		questions: [{
			...AUTH.questions[0]!,
			description: "Context with **weight**\n\n1. first\n2. second",
			options: [
				{ id: "a", label: "Use `pg`", description: "One *line*" },
				{ id: "b", label: "Hosted", description: "Trade-offs:\n\n- cost\n- latency" },
			],
		}],
	};
	let markup = render({ definition }, MARKED);
	expect(markup).toContain(
		'<div class="question-hint" data-question-markdown=""><span data-block="">Context with **weight**',
	);
	// A label sits in the option's control, so it never carries a link of its own.
	expect(markup).toContain(
		'<span class="question-label"><span data-inline="plain">Use `pg`</span>',
	);
	expect(markup).toContain(
		'<span class="question-desc"><span data-inline="links">One *line*</span>',
	);
	expect(markup).toContain(
		'<div class="question-desc" data-question-markdown=""><span data-block="">Trade-offs:',
	);
});

test("an answered card keeps its body, folding a long one away behind a disclosure", () => {
	let answers = [{ question: QUESTION, optionIds: ["b"], choices: ["GitHub Apps"] }];
	let short = render({ definition: withQuestion(QUESTION), status: "answered", answers }, MARKED);
	expect(short).toContain('data-block="">- Storage');
	expect(short).not.toContain("question-body-toggle");
	expect(short.slice(short.indexOf("<h4"), short.indexOf("</h4>"))).not.toContain("Storage");

	let long = `Confirm the earlier answers\n\n${
		Array.from({ length: 12 }, (_, index) => `- Answer ${index + 1}`).join("\n")
	}`;
	let folded = render({
		definition: withQuestion(long),
		status: "answered",
		answers: [{ ...answers[0]!, question: long }],
	}, MARKED);
	expect(folded).toContain('aria-expanded="false" class="question-body-toggle"');
	expect(folded).toContain('>Show details</button><div hidden=""');
	expect(folded).toContain("- Answer 12");
});

test("an expired card shows the heading and the body it asked", () => {
	let markup = render({ definition: withQuestion(QUESTION), status: "expired" }, MARKED);
	expect(markup).toContain('data-inline="links">Confirm the earlier answers');
	expect(markup).toContain('data-block="">- Storage');
});
