import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

test("evidence hover belongs only to an open inline conversation card", () => {
	let open = {
		...DECIDED,
		questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
	};
	let evidence = createElement("p", null, "Evidence");
	let render = (value: typeof open, status: "open" | "decided", presentation?: "inline" | "list") =>
		renderToStaticMarkup(createElement(QuestionnaireCard, {
			evidence,
			meta: { ...META, status },
			presentation,
			value,
		}));
	let eligible = render(open, "open");
	let noThread = render({ ...open, thread: undefined } as never, "open");
	let settled = render(open, "decided");
	let list = render(open, "open", "list");
	let noEvidence = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, status: "open" },
		value: open,
	}));
	for (let markup of [eligible, noThread, settled, noEvidence]) {
		expect(markup).toContain("plan-evidence-host");
	}
	expect(eligible).toContain('data-evidence-hover=""');
	for (let markup of [noThread, settled, list, noEvidence]) {
		expect(markup).not.toContain('data-evidence-hover=""');
	}
});

test("a delayed decided projection stays non-editable in the Decisions list", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: true,
		meta: META,
		presentation: "list",
		value: {
			...DECIDED,
			questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
		},
		wire: { ask: async () => ({ ok: true }) } as never,
	}));
	expect(markup).toContain("Saved decision");
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain(">Save<");
});

test("resolved card actions require an editable connected viewer", () => {
	let editable = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: true,
		meta: META,
		presentation: "list",
		value: DECIDED,
		wire: { ask: async () => ({ ok: true }) } as never,
	}));
	let reader = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: META,
		presentation: "list",
		value: DECIDED,
		wire: { ask: async () => ({ ok: true }) } as never,
	}));
	expect(editable).toContain(">Reopen<");
	expect(editable).toContain(">Discard<");
	expect(editable).not.toMatch(/<button[^>]*disabled=""[^>]*>Reopen</);
	expect(reader).not.toContain(">Reopen<");
	expect(reader).not.toContain(">Discard<");
});
