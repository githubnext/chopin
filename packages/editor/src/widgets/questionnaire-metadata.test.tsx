import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

// Whole original callbacks235/477, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("reopened metadata ignores a delayed answered projection", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: { ...META, status: "reopened" },
		value: DECIDED,
	}));
	expect(markup).toContain("<input");
	expect(markup).not.toContain("Decided by @ana");
});

test("an older custom answer still renders its text", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		value: {
			id: "w",
			by: "ana",
			at: "2026-09-01T10:00:00.000Z",
			questions: [{
				id: "q",
				header: "Scope",
				prompt: "What belongs in the first cut?",
				multiple: true,
				options: [{ id: "a", label: "Anchors" }],
				answer: "Only collaborative anchors",
			}],
		},
	}));
	expect(markup).toContain("Only collaborative anchors");
});

test("decided metadata prevents inputs before the answer projection arrives", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: META,
		value: { ...DECIDED, questions: [{ ...DECIDED.questions[0]!, answer: undefined }] },
	}));
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain("Save answer");
});

test("discarded metadata attributes its resolver without retaining the old answer actor", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		meta: { ...META, status: "discarded", resolver: "bea" },
		value: { ...DECIDED, at: "2026-09-01T10:00:00.000Z" },
	}));
	expect(markup).toContain("Discarded by");
	expect(markup).toContain("@bea");
	expect(markup).not.toContain("Answered by");
	expect(markup).not.toContain("@ana");
	expect(markup).not.toContain("<input");
});

test("metadata with no terminal actor does not borrow the previous node's actor", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		meta: { ...META, status: "discarded" },
		value: DECIDED,
	}));
	expect(markup).not.toContain("@ana");
	expect(markup).not.toContain("Answered by");
});

test("decided metadata attributes its recorded resolver instead of a stale node owner", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		meta: { ...META, resolver: "bea", decidedAt: 1_000 },
		value: DECIDED,
	}));
	expect(markup).toContain("Answered by");
	expect(markup).toContain("@bea");
	expect(markup).not.toContain("@ana");
});

test("document-only decided cards preserve current provenance", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		value: DECIDED,
	}));
	expect(markup).toContain("Answered by");
	expect(markup).toContain("@ana");
});

test("chosen IDs determine resolved text while preserving the existing card layout", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		presentation: "list",
		value: { ...DECIDED, questions: [{ ...DECIDED.questions[0]!, answer: "Old summary" }] },
	}));
	expect(markup).toContain("GitHub Apps");
	expect(markup).not.toContain("Old summary");
});

test("an open advisory suggestion projects into existing read-only controls", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: { ...META, status: "open", suggested: { optionId: "b", revision: 7, messageIds: ["m"] } },
		value: {
			...DECIDED,
			questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
		},
	}));
	let radios = markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
	expect(radios[1]).toContain('checked=""');
	expect(radios[1]).toContain('disabled=""');
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain("Cancel");
});
