import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

test("a discarded record retires an old answer without labelling it a cancellation", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: true,
		connected: true,
		meta: { ...META, status: "discarded", resolver: "bea" },
		value: DECIDED,
		wire: { ask: async () => ({ ok: true }) } as never,
	}));
	expect(markup).toContain('data-plan-sidecar-questionnaire="w"');
	expect(markup).toContain("Discarded");
	expect(markup).toContain("@bea");
	expect(markup).not.toMatch(/cancelled/i);
	expect(markup).not.toContain("Answered by");
	expect(markup).not.toContain("@ana");
	expect(markup).not.toContain("GitHub Apps");
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain(">Reopen<");
	expect(markup).not.toContain(">Discard<");
});

test("a discarded document fallback preserves its card identity and provenance", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		canEdit: false,
		value: { ...DECIDED, status: "discarded" },
	}));
	expect(markup).toContain('data-plan-sidecar-questionnaire="w"');
	expect(markup).toContain("Discarded by");
	expect(markup).toContain("@ana");
	expect(markup).not.toMatch(/cancelled/i);
	expect(markup).not.toContain("Answered by");
	expect(markup).not.toContain("<input");
});

test("discarded inline metadata keeps the card identity while hiding its old answer", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, status: "discarded", resolver: "bea" },
		value: DECIDED,
	}));
	expect(markup).toContain('data-plan-sidecar-questionnaire="w"');
	expect(markup).toContain('data-card-hidden=""');
	expect(markup).toContain('hidden=""');
	expect(markup).not.toContain("GitHub Apps");
	expect(markup).not.toContain("<input");
});
