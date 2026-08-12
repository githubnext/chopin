import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionView } from "@chopin/question/react";

const SINGLE = {
	questions: [{
		id: "storage",
		header: "Storage",
		question: "Where should room state live?",
		multiple: false,
		options: [{ id: "mdx", label: "MDX on disk", description: "Readable and diffable." }],
	}],
};

test("a single decision renders as a saveable card without tabs", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionView, {
			definition: SINGLE,
			drafts: {},
			onSubmit() {},
		}),
	);

	expect(markup).toContain("Decision");
	expect(markup).toContain("Save");
	expect(markup).not.toContain('role="tablist"');
});

test("a stored multi-question questionnaire keeps its tabbed compatibility view", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionView, {
			definition: {
				questions: [
					...SINGLE.questions,
					{
						id: "scope",
						header: "Scope",
						question: "What belongs in the first cut?",
						multiple: true,
						options: [{ id: "anchors", label: "Anchors", description: "Link prose." }],
					},
				],
			},
			drafts: {},
			onSubmit() {},
		}),
	);

	expect(markup).toContain('role="tablist"');
	expect(markup).toContain("Scope");
});
