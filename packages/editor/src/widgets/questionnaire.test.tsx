import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionView } from "@chopin/question/react";
import { QuestionnaireCard } from "./questionnaire";

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
	expect(markup).toContain("Save answer");
	expect(markup).toContain('data-plan-icon="check"');
	expect(markup).toContain('aria-hidden="true"');
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

test("a stored unanswered questionnaire keeps its compatibility view without a live record", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionnaireCard, {
			canEdit: false,
			connected: true,
			value: {
				id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
				questions: [
					{
						id: "storage",
						header: "Storage",
						prompt: "Where should room state live?",
						multiple: false,
						options: [{ id: "mdx", label: "MDX on disk" }],
					},
					{
						id: "scope",
						header: "Scope",
						prompt: "What belongs in the first cut?",
						multiple: true,
						options: [{ id: "anchors", label: "Anchors" }],
					},
				],
			},
		}),
	);

	expect(markup).toContain('role="tablist"');
	expect(markup).toContain("disabled");
	expect(markup).toContain("Next");
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain("Cancel");
});

test("a read-only decision remains linked but has no answer actions", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionnaireCard, {
			canEdit: false,
			connected: true,
			onQuestionSelect() {},
			places: { storage: 1 },
			value: {
				id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
				questions: [{
					id: "storage",
					header: "Storage",
					prompt: "Where should room state live?",
					multiple: false,
					options: [{ id: "mdx", label: "MDX on disk" }],
				}],
			},
		}),
	);

	expect(markup).toContain("show in plan");
	expect(markup).toContain("disabled");
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain("Cancel");
});
