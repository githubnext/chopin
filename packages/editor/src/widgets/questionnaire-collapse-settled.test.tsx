import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

const JOB = "prose:card:decided:card:1";

test("a settled line says a conversation decision is being written up only while its job runs", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, writeup: { status: "writing", job: JOB } },
		value: DECIDED,
	}));
	expect(markup).toContain('class="decision-collapse is-open"');
	expect(markup).toContain("data-card-settled");
	expect(markup).toContain("Decided: GitHub Apps · @ana");
	expect(markup).toContain("Writing up…");
	expect(markup).not.toContain("Retry");

	let idle = renderToStaticMarkup(createElement(QuestionnaireCard, { meta: META, value: DECIDED }));
	expect(idle).toContain("Decided: GitHub Apps · @ana");
	expect(idle).not.toContain("Writing up…");
	expect(idle).toContain("Not linked yet");
});

test("a failed write-up says so and offers Retry only to an editable connected viewer", () => {
	let failed = { ...META, writeup: { status: "failed" as const, job: JOB } };
	let editable = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: true,
		meta: failed,
		value: DECIDED,
		wire: { ask: async () => ({}), send() {}, on: () => () => {} } as never,
	}));
	let reader = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: failed,
		value: DECIDED,
	}));
	expect(editable).toContain("Couldn&#x27;t write this up");
	expect(editable).not.toContain("Writing up…");
	expect(editable).toMatch(
		/<button aria-label="Retry write-up"(?![^>]*disabled)[^>]*>Retry<\/button>/,
	);
	expect(reader).toMatch(
		/<button aria-label="Retry write-up"[^>]*disabled=""[^>]*>Retry<\/button>/,
	);
});

test("a linked relation stays the sole control after a write-up failure", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, writeup: { status: "failed", job: JOB } },
		onQuestionSelect: () => {},
		relations: { [DECIDED.questions[0]!.id]: "linked" },
		value: DECIDED,
	}));
	expect(markup).toContain("Show in document");
	expect(markup).not.toContain("Retry write-up");
	expect(markup).not.toContain("Couldn&#x27;t write this up");
});

test("an orphaned settled line says the prose was removed", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, proseOrphaned: true },
		value: DECIDED,
	}));
	expect(markup).toContain("Decided: GitHub Apps · @ana");
	expect(markup).toContain("Related text was removed");
	expect(markup).not.toContain("Writing up…");
});

test("an orphaned settled line offers Reopen only to an editable connected viewer", () => {
	let editable = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: true,
		meta: { ...META, proseOrphaned: true },
		value: DECIDED,
	}));
	let reader = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: { ...META, proseOrphaned: true },
		value: DECIDED,
	}));
	let offline = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: false,
		meta: { ...META, proseOrphaned: true },
		value: DECIDED,
	}));
	expect(editable).toMatch(/<button[^>]*>Reopen<\/button>/);
	expect(reader).toMatch(/<button[^>]*disabled=""[^>]*>Reopen<\/button>/);
	expect(offline).toMatch(/<button[^>]*disabled=""[^>]*>Reopen<\/button>/);
});

test("a Planner settled line never claims it is writing prose", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, origin: "planner", writeup: { status: "writing", job: JOB } },
		value: DECIDED,
	}));
	expect(markup).toContain("data-card-settled");
	expect(markup).not.toContain("Writing up…");
});

test("decided metadata keeps a delayed unanswered projection safely settled", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: META,
		value: {
			...DECIDED,
			questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
		},
	}));
	expect(markup).toContain("data-card-settled");
	expect(markup).toContain("Decided: Saved decision · @ana");
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain(">Save<");
});

test("a Planner settled line names each relationship state", () => {
	let line = (relation: "pending" | "empty" | "orphaned") =>
		renderToStaticMarkup(createElement(QuestionnaireCard, {
			meta: { ...META, origin: "planner" },
			relations: { [DECIDED.questions[0]!.id]: relation },
			value: DECIDED,
		}));
	expect(line("pending")).toContain("Linking…");
	expect(line("empty")).toContain("No related text");
	expect(line("orphaned")).toContain("Related text was removed");
	expect(line("orphaned")).toMatch(/>Reopen<\/button>/);
	expect(line("empty")).not.toContain("Reopen");
});

test("a pending line without a Planner does not promise linking", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...META, origin: "planner" },
		planner: false,
		relations: { [DECIDED.questions[0]!.id]: "pending" },
		value: DECIDED,
	}));
	expect(markup).toContain("Not linked yet");
	expect(markup).not.toContain("Linking…");
});
