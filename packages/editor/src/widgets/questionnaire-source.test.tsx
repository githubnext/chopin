import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

let showSource = () => {};

test.each([
	{ thread: "t", callback: true, expected: true },
	{ thread: undefined, callback: true, expected: false },
	{ thread: "t", callback: false, expected: false },
])("Source needs saved thread $thread and callback $callback", ({ thread, callback, expected }) => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: false,
		meta: { ...META, status: "reopened", thread },
		onCardSource: callback ? showSource : undefined,
		value: DECIDED,
	}));
	expect(markup.includes('aria-label="Show source in chat"')).toBe(expected);
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain(">Cancel<");
	expect(markup).toContain("disabled");
});

test("resolved list cards retain their current provenance without open-card Source controls", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, resolver: "ana", thread: "t" },
		onCardSource: showSource,
		presentation: "list",
		value: DECIDED,
	}));
	expect(markup).not.toContain('aria-label="Show source in chat"');
	expect(markup).toContain("Answered by");
});
