import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionnaireCard, writingEntries, writingProse } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

import type { Question } from "@chopin/protocol";
import type { Relation } from "@chopin/question";

const PLANNER = { ...META, origin: "planner" as const };
const QUESTION = DECIDED.questions[0]!.id;

function inline(relation: Relation, presentation: "inline" | "list" = "inline") {
	return renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: PLANNER,
		presentation,
		relations: { [QUESTION]: relation },
		value: DECIDED,
	}));
}

test.each(["pending", "empty", "orphaned", "linked"] as const)(
	"a decided card that is %s draws nothing in the document",
	relation => {
		let markup = inline(relation);
		expect(markup).toMatch(/^<div[^>]*data-card-hidden=""[^>]*hidden=""[^>]*><\/div>$/);
		expect(markup).not.toContain("Decided:");
	},
);

test("a decided card keeps its full card and relation in Decisions", () => {
	expect(inline("empty", "list")).toContain("No related text");
	expect(inline("orphaned", "list")).toContain("Related text was removed");
	expect(inline("pending", "list")).toContain("Linking…");
});

test("an open card stays in the document", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: { ...PLANNER, status: "open" },
		value: {
			...DECIDED,
			questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
		},
	}));
	expect(markup).not.toContain("data-card-hidden");
	expect(markup).toContain("What auth system should we use?");
});

test("a hidden card that speaks for the write-ups shows one quiet line", () => {
	let one = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: PLANNER,
		value: DECIDED,
		writing: 1,
	}));
	let five = renderToStaticMarkup(createElement(QuestionnaireCard, {
		meta: PLANNER,
		value: DECIDED,
		writing: 5,
	}));
	expect(one).toContain("Writing up a decision…");
	expect(five).toContain("Writing up 5 decisions…");
	expect(five).toContain('role="status"');
	expect(five).not.toContain("data-card-hidden");
});

test("only running work counts as writing up a Planner decision", () => {
	let busy = { unwritten: true, plannerBusy: true };
	expect(writingProse(DECIDED, PLANNER, busy)).toBe(true);
	expect(writingProse(DECIDED, undefined, busy)).toBe(true);
	// Pending with no Planner running, or reviewed: nothing is on its way.
	expect(writingProse(DECIDED, PLANNER, { unwritten: true, plannerBusy: false })).toBe(false);
	expect(writingProse(DECIDED, PLANNER, { unwritten: false, plannerBusy: true })).toBe(false);
	expect(writingProse(DECIDED, { ...PLANNER, proseOrphaned: true }, busy)).toBe(false);
	expect(writingProse(DECIDED, { ...PLANNER, hasProse: true }, busy)).toBe(false);
	expect(writingProse(DECIDED, { ...PLANNER, status: "discarded" }, busy)).toBe(false);
	expect(writingProse(DECIDED, { ...PLANNER, status: "open" }, busy)).toBe(false);
});

test("a conversation decision is writing up only while its job runs", () => {
	let idle = { unwritten: true, plannerBusy: true };
	let job = "prose:w:decided:w:1";
	expect(writingProse(DECIDED, { ...META, writeup: { status: "writing", job } }, idle)).toBe(true);
	expect(writingProse(DECIDED, { ...META, writeup: { status: "failed", job } }, idle)).toBe(false);
	expect(writingProse(DECIDED, META, idle)).toBe(false);
});

test("a failed write-up offers Retry from the Decisions card", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: true,
		connected: true,
		meta: { ...META, writeup: { status: "failed", job: "prose:w:decided:w:1" } },
		presentation: "list",
		value: DECIDED,
		wire: { ask: async () => ({}), send() {}, on: () => () => {} } as never,
	}));
	expect(markup).toContain("Couldn&#x27;t write this up");
	expect(markup).toMatch(
		/<button aria-label="Retry write-up"(?![^>]*disabled)[^>]*>Retry<\/button>/,
	);
});

test("decided cards a deck still draws are not counted as written up out of sight", () => {
	let open = {
		...DECIDED,
		id: "open",
		questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
	};
	let entries = [
		{ id: "open", value: open },
		{ id: "w", value: DECIDED },
		{ id: "alone", value: { ...DECIDED, id: "alone" } },
	];
	let cards = new Map<string, Question.CardMeta>([
		["open", { ...PLANNER, status: "open" as const }],
		["w", PLANNER],
		["alone", PLANNER],
	]);
	let store = {
		runOf: (id: string) => (id === "alone" ? undefined : ["open", "w"]),
		counts: () => ({}),
		proseKey: () => undefined,
		plannerBusy: () => true,
		unwritten: () => true,
	};
	expect(writingEntries(entries, cards, store, true).map(entry => entry.id)).toEqual(["alone"]);
	// Without decks, as on a phone, the deck's decided card is hidden and counts too.
	expect(writingEntries(entries, cards, store, true, false).map(entry => entry.id))
		.toEqual(["w", "alone"]);
});

test("the Decisions card says a conversation write-up is running only while its job does", () => {
	let job = "prose:w:decided:w:1";
	let card = (meta: Question.CardMeta) =>
		renderToStaticMarkup(createElement(QuestionnaireCard, {
			meta,
			presentation: "list",
			value: DECIDED,
		}));
	expect(card({ ...META, writeup: { status: "writing", job } })).toContain("Writing up…");
	expect(card(META)).not.toContain("Writing up…");
	expect(card({ ...META, origin: "planner", writeup: { status: "writing", job } }))
		.not.toContain("Writing up…");
});
