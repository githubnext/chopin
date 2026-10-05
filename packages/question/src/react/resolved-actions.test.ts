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

test("a decided card shows static choices and one linked question heading", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		status: "answered",
		answers: [{ question: AUTH.questions[0].question, choices: ["GitHub Apps"], optionIds: ["b"] }],
		places: { q: 1 },
		onQuestionSelect: () => {},
	}));

	expect(markup).toContain('class="question-head"');
	expect(markup).toContain('class="question-mark"');
	expect(markup).toMatch(/<h4[^>]*><button[^>]*data-ace-question-id="q"/);
	expect(markup.match(/data-ace-question-id="q"/g)).toHaveLength(1);
	expect(markup).toContain('class="question-choice-row question-option"');
	expect(markup).toContain('class="question-choice-row question-option" data-selected=""');
	expect(markup).toContain('class="question-key"');
	expect(markup).toContain('class="question-check"');
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain("<label");
});

test("multiple selections and legacy text answers remain visible in question order", () => {
	let definition = {
		questions: [
			{
				...AUTH.questions[0],
				multiple: true,
				options: [
					...AUTH.questions[0].options,
					{ id: "c", label: "Passkeys", description: "For members" },
				],
			},
			{
				id: "scope",
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: false,
				options: [{ id: "d", label: "Invites", description: "" }],
			},
		],
	};
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		status: "answered",
		answers: [
			{
				question: definition.questions[0].question,
				choices: ["Auth0", "Passkeys"],
				optionIds: ["a", "c"],
			},
			{ question: definition.questions[1].question, custom: "Only collaborative anchors" },
		],
	}));

	expect(markup.match(/data-selected=""/g)).toHaveLength(3);
	expect(markup.indexOf("What auth system should we use?"))
		.toBeLessThan(markup.indexOf("What belongs in the first cut?"));
	expect(markup).toContain("Only collaborative anchors");
	expect(markup).toContain("Selected: ");
	expect(markup).not.toContain("<input");
});

test("a legacy answer that no longer matches an option keeps its chosen text", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		status: "answered",
		answers: [{ question: AUTH.questions[0].question, choices: ["Only GitHub teams"] }],
	}));

	expect(markup).toContain("Only GitHub teams");
	expect(markup.match(/data-selected=""/g)).toHaveLength(1);
	expect(markup).not.toContain("<input");
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
