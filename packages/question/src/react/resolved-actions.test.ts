import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Whole original160/178/190/203 callbacks, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a decided card offers Reopen and Discard when allowed", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		status: "answered",
		answers: [{
			question: "What auth system should we use?",
			choices: ["GitHub Apps"],
			optionIds: ["b"],
		}],
		resolver: "ana",
		onReopen: () => {},
		onDiscard: () => {},
	}));
	expect(markup).toContain(">Reopen<");
	expect(markup).toContain(">Discard<");
});

test("a decided card announces a reopen or discard failure", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		status: "answered",
		answers: [{ question: "What auth system should we use?", choices: ["GitHub Apps"] }],
		error: "Could not reopen it. Try again.",
	}));
	expect(markup).toContain('role="alert"');
	expect(markup).toContain("Could not reopen it. Try again.");
});

test("a decided card without its projected answer stays non-editable", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		status: "answered",
		onReopen: () => {},
		onDiscard: () => {},
	}));
	expect(markup).toContain("Saved decision");
	expect(markup).not.toContain("<input");
	expect(markup).toContain(">Reopen<");
});

test("a resolved legacy multi-card keeps actions and errors", () => {
	let definition = {
		questions: [AUTH.questions[0], {
			id: "scope",
			header: "Scope",
			question: "What belongs in the first cut?",
			multiple: true,
			options: [{ id: "anchors", label: "Anchors", description: "" }],
		}],
	};
	let editable = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		status: "answered",
		answers: [
			{ question: AUTH.questions[0].question, choices: ["GitHub Apps"] },
			{ question: "What belongs in the first cut?", choices: ["Anchors"] },
		],
		error: "Could not discard this decision.",
		onReopen: () => {},
		onDiscard: () => {},
	}));
	let reader = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		status: "answered",
		answers: [{ question: AUTH.questions[0].question, choices: ["GitHub Apps"] }],
	}));
	expect(editable).toContain(">Reopen<");
	expect(editable).toContain(">Discard<");
	expect(editable).toContain('role="alert"');
	expect(reader).not.toContain(">Reopen<");
	expect(reader).not.toContain(">Discard<");
});
