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

test("a single decision renders as a saveable card without a stepper", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionView, {
			definition: SINGLE,
			drafts: {},
			onSubmit() {},
		}),
	);

	expect(markup).toContain("Where should room state live?");
	expect(markup).toContain("Add an option");
	expect(markup).toContain(">Save<");
	expect(markup).not.toContain("Save answer");
	expect(markup).not.toContain("Questions");
	expect(markup).not.toContain(">Next<");
});

test("a stored multi-question questionnaire keeps its stepper compatibility view", () => {
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

	expect(markup).not.toContain('role="tablist"');
	expect(markup).toContain("Previous question");
	expect(markup).toContain("Storage");
	expect(markup).toContain("1/2");
	expect(markup).toContain(">Next<");
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

	expect(markup).not.toContain('role="tablist"');
	expect(markup).toContain("disabled");
	expect(markup).toContain("Next");
	expect(markup).not.toContain(">Save<");
	expect(markup).not.toContain("Discard");
});

test("a host motion contract owns the active question step", () => {
	let markup = renderToStaticMarkup(
		createElement(QuestionnaireCard, {
			canEdit: false,
			connected: true,
			motion: {
				contract: { className: "motion-content-swap", closeDuration: 250 },
				immediately: () => true,
			},
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

	expect(markup.match(/class="motion-content-swap/g)).toHaveLength(1);
	expect(markup).toContain("question-step-swap content-swap-stack");
	expect(markup).not.toContain('data-content-swap-state="outgoing"');
	expect(markup).not.toContain(' inert=""');
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
	expect(markup).not.toContain(">Save<");
	expect(markup).not.toContain("Discard");
});
