import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { visibleDecisionView } from "@chopin/editor";

import { BUILD_UNAVAILABLE, decisionAttention, DecisionViewControl } from "./decision-view-control";
import { storedDocumentView } from "./workspace-model";

test("a questionnaire-only document opens Decisions while prose keeps Plan visible", () => {
	expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, false, 2)).toBe("decisions");
	expect(visibleDecisionView({ phase: "initial", preferred: "plan" }, true, 1)).toBe("plan");
});

test("attention only starts when unanswered decisions grow", () => {
	expect(decisionAttention(1, 2)).toBe(true);
	expect(decisionAttention(2, 2)).toBe(false);
	expect(decisionAttention(2, 1)).toBe(false);
});

test("stored legacy work destinations normalize to Document", () => {
	expect(storedDocumentView("tasks")).toBe("plan");
	expect(storedDocumentView("background-work")).toBe("plan");
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

test("the document control contains only Document and Decisions", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 0, view: "plan" }),
	);

	expect(markup).not.toContain("Tasks &amp; Progress");
});

test("the document control never exposes Background Work", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, {
			onView: () => {},
			unanswered: 0,
			view: "plan",
		}),
	);

	expect(markup).toContain(">Document<");
	expect(markup).toContain(">Decisions<");
	expect(markup).not.toContain("Background Work");
});

test("child mode renders only Document and Decisions destinations", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, {
			onView: () => {},
			unanswered: 0,
			view: "plan",
		}),
	);
	expect(markup).toContain(">Document<");
	expect(markup).toContain(">Decisions<");
	expect(markup).not.toContain("Tasks &amp; Progress");
	expect(markup).not.toContain("Background Work");
});

test("unanswered decisions expose an accessible count with quiet styling", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, {
			attention: true,
			onView: () => {},
			unanswered: 2,
			view: "plan",
		}),
	);

	expect(markup).toContain('aria-label="Decisions, 2 unanswered"');
	expect(markup).toContain('aria-hidden="true"');
	expect(markup).toContain('data-motion-feedback="count"');
	let button = markup.match(/<button[^>]*aria-label="Decisions, 2 unanswered"[^>]*>/)?.[0];
	expect(button).toContain("gap-1");
	let badgeClass = markup.match(/class="([^"]+)" data-motion-feedback="count"/)?.[1];
	let classes = badgeClass?.split(/\s+/) ?? [];
	for (
		let className of [
			"editor-count-control",
			"rounded-sm",
			"text-xs",
			"text-text-tertiary",
			"tabular-nums",
		]
	) {
		expect(classes).toContain(className);
	}
});

test("Build follows Decisions and marks the selected panel", () => {
	let markup = renderToStaticMarkup(createElement(DecisionViewControl, {
		buildEnabled: true,
		onView() {},
		unanswered: 0,
		view: "build",
	}));
	expect(markup.indexOf(">Decisions<")).toBeLessThan(markup.indexOf(">Build<"));
	expect(markup).toContain('aria-current="page" aria-pressed="true"');
	expect(markup).not.toContain('aria-pressed="true" class="btn btn-sm gap-1');
});

test("Build is a segment only for a document that can be built", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, { onView: () => {}, unanswered: 0, view: "plan" }),
	);

	expect(markup).not.toContain(">Build<");
});

test("Build waits for document content and says why", () => {
	let markup = renderToStaticMarkup(
		createElement(DecisionViewControl, {
			buildEnabled: false,
			onView: () => {},
			unanswered: 0,
			view: "plan",
		}),
	);

	expect(markup).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Build</);
	expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Build</);
	expect(markup).toContain(BUILD_UNAVAILABLE);
});

test("a stored Build view reopens on Document", () => {
	expect(storedDocumentView("build")).toBe("plan");
});
