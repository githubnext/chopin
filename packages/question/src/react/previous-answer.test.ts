import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { previousFor, QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";

// Whole original123/132/139 callbacks, archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2.
test("a reopened decision says what it replaced", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		previous: { labels: ["GitHub Apps"], by: "ana" },
	}));
	expect(markup).toContain("Previously: GitHub Apps · @ana");
});

test("previous answers remain keyed to their active question", () => {
	expect(previousFor({
		access: { labels: ["GitHub Apps"], by: "ana" },
		storage: { labels: ["PostgreSQL"], by: "ben" },
	}, "storage")).toEqual({ labels: ["PostgreSQL"], by: "ben" });
});

test("a legacy multi-card renders the active question's previous answer", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [AUTH.questions[0], {
				id: "scope",
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: true,
				options: [{ id: "anchors", label: "Anchors", description: "" }],
			}],
		},
		drafts: {},
		previous: {
			q: { labels: ["GitHub Apps"], by: "ana" },
			scope: { labels: ["Anchors"], by: "ben" },
		},
	}));
	expect(markup).toContain("Previously: GitHub Apps · @ana");
	expect(markup).not.toContain("Previously: Anchors · @ben");
});
