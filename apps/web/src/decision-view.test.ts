import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { visibleDecisionView } from "@chopin/editor";

import { decisionAttention, DecisionViewControl } from "./decision-view-control";

test("a questionnaire-only document opens Decisions while prose keeps Plan visible", () => {
	expect(visibleDecisionView("plan", false, 2)).toBe("decisions");
	expect(visibleDecisionView("plan", true, 1)).toBe("plan");
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
