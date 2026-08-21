import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { visibleDecisionView } from "@chopin/editor";

import { decisionAttention, DecisionViewControl } from "./decision-view-control";

test("a questionnaire-only document opens Decisions while prose keeps Plan visible", () => {
	expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, false, 2)).toBe("decisions");
	expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, true, 1)).toBe("plan");
});

test("attention only starts when unanswered decisions grow", () => {
	expect(decisionAttention(1, 2)).toBe(true);
	expect(decisionAttention(2, 2)).toBe(false);
	expect(decisionAttention(2, 1)).toBe(false);
});

test("zero unanswered decisions suppresses the badge", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 0, view: "plan" }),
	);

	expect(markup).not.toContain("data-plan-decision-count");
});

test("the document tab uses the public Document name", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 0, view: "plan" }),
	);

	expect(markup).toContain(">Document<");
});

test("the unavailable Tasks & Progress tab is disabled without a count", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 0, view: "plan" }),
	);

	expect(markup).toContain('disabled=""');
	expect(markup).toContain("task-progress-tab");
	expect(markup).toContain(">Tasks &amp; Progress<");
});

test("the Decisions control names its unanswered count", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 2, view: "plan" }),
	);

	expect(markup).toContain('aria-label="Decisions, 2 unanswered"');
});
