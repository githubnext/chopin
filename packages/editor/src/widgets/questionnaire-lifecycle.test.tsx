import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

let wire = { ask: async () => ({ ok: true }) } as never;

test("terminal lifecycle actions require current edit permission and a connected wire", () => {
	let editable = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: META,
		value: DECIDED,
		wire,
	}));
	expect(editable).toContain(">Reopen<");
	expect(editable).toContain(">Discard<");
	expect(editable).not.toMatch(/<button[^>]*disabled=""[^>]*>Reopen</);
	expect(editable).not.toContain("question-resolved-meta");
	for (
		let permission of [
			{ canEdit: false, connected: true, wire },
			{ canEdit: true, connected: false, wire },
			{ canEdit: true, connected: true, wire: undefined },
		]
	) {
		let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
			presentation: "list",
			...permission,
			meta: META,
			value: DECIDED,
		}));
		expect(markup).not.toContain(">Reopen<");
		expect(markup).not.toContain(">Discard<");
	}
});

test("current metadata governs lifecycle actions despite a stale discarded projection", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: { ...META, resolver: "bea" },
		value: { ...DECIDED, status: "discarded" },
		wire,
	}));
	expect(markup).toContain(">Reopen<");
	expect(markup).toContain(">Discard<");
	expect(markup).toContain("Answered by");
	expect(markup).toContain("@bea");
	expect(markup).not.toContain("@ana");
});

test("answered cards use the open surface and put attribution after the chosen options", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: { ...META, resolver: "ana" },
		value: DECIDED,
		wire,
	}));

	expect(markup).toContain("bg-page shadow-resting");
	expect(markup).not.toContain("bg-inset");
	expect(markup.indexOf("Answered by")).toBeGreaterThan(markup.indexOf("data-selected"));
	expect(markup.indexOf("Answered by")).toBeLessThan(markup.indexOf(">Reopen<"));
});

test("discarded metadata retires lifecycle actions and the old projection actor", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: { ...META, status: "discarded", resolver: "bea" },
		value: DECIDED,
		wire,
	}));
	expect(markup).not.toContain(">Reopen<");
	expect(markup).not.toContain(">Discard<");
	expect(markup).toContain("Discarded by");
	expect(markup).toContain("@bea");
	expect(markup).not.toContain("@ana");
	expect(markup).not.toContain("<input");
});

test("metadata arriving before answer projection shows a saved placeholder and permitted actions", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: META,
		value: { ...DECIDED, questions: [{ ...DECIDED.questions[0]!, answer: undefined }] },
		wire,
	}));
	expect(markup).toContain("Saved decision");
	expect(markup).toContain(">Reopen<");
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain("Save answer");
});
