import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

test("Cancel remains available when an open card also offers Discard", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		onCancel: () => {},
		onDiscard: () => {},
	}));
	expect(markup).toContain(">Cancel<");
	expect(markup).toContain(">Discard<");
	expect(markup).not.toContain("Cancel without answering?");
	expect(markup).not.toContain("Discard this decision?");
});

test("the existing Cancel-only card retains its caption and disabled guard", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: true,
		onCancel: () => {},
	}));
	expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Cancel</);
	expect(markup).not.toContain(">Discard<");
});
