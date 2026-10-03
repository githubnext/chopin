import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Whole original307 callback, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a refining card says so under its header", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		refining: true,
	}));
	expect(markup).toContain("Chopin is refining…");
	expect(markup).toContain('data-refining="true"');
});
