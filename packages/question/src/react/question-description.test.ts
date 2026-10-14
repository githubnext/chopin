import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

let description = "Our `session` data must survive restarts.";
let definition = { questions: [{ ...AUTH.questions[0]!, description }] };

test("the full open card places context beneath its concise question", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, { definition, drafts: {} }));
	expect(markup).toContain("What auth system should we use?");
	expect(markup).toContain(
		'Our <code class="inline-code">session</code> data must survive restarts.',
	);
	expect(markup.indexOf("Our ")).toBeGreaterThan(markup.indexOf("</h4>"));
	expect(markup.indexOf("Our ")).toBeLessThan(markup.indexOf("<fieldset"));
});

test("the full answered card retains context beneath its concise question", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		status: "answered",
		answers: [{
			question: AUTH.questions[0]!.question,
			optionIds: ["b"],
			choices: ["GitHub Apps"],
		}],
	}));
	expect(markup).toContain("data must survive restarts.");
	expect(markup.indexOf("Our ")).toBeGreaterThan(markup.indexOf("</h4>"));
	expect(markup).toContain("GitHub Apps");
});
