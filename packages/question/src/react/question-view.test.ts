import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { currentQuestion, QuestionView } from "./question-view";

test("a replacement definition falls back before rendering when its active question disappears", () => {
	let storage = {
		id: "storage",
		header: "Storage",
		question: "Where should room state live?",
		multiple: false,
		options: [],
	};
	let scope = {
		id: "scope",
		header: "Scope",
		question: "What belongs in the first cut?",
		multiple: false,
		options: [],
	};

	expect(currentQuestion({ questions: [storage, scope] }, "removed")).toBe(storage);
});

test("a host renderer receives only the active question panel", () => {
	let definition = {
		questions: [
			{
				id: "storage",
				header: "Storage",
				question: "Where should room state live?",
				multiple: false,
				options: [],
			},
			{
				id: "scope",
				header: "Scope",
				question: "What belongs in the first cut?",
				multiple: false,
				options: [],
			},
		],
	};
	let steps: string[] = [];

	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: {},
		renderStep: ({ children, question }) => {
			steps.push(question);
			return children;
		},
	}));

	expect(steps).toEqual(["storage"]);
	expect(markup).not.toContain("content-swap-stack");
});

test("a host can present an error as motion feedback", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: {
			questions: [{
				id: "storage",
				header: "Storage",
				question: "Where should room state live?",
				multiple: false,
				options: [],
			}],
		},
		drafts: {},
		error: "Could not save the answer.",
		errorClassName: "host-error-feedback",
	}));

	expect(markup).toContain("host-error-feedback");
	expect(markup).toContain('role="alert"');
	expect(markup).toContain('data-motion-feedback="alert"');
});

const ROLLOUT = {
	id: "rollout",
	header: "Rollout",
	question: "How should we roll this out?",
	multiple: false,
	options: [
		{ id: "all", label: "All at once", description: "Everyone moves on the same day" },
		{ id: "team", label: "Team by team", description: "" },
	],
};

test("options carry letter tiles and the last row offers to add one", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [ROLLOUT] },
		drafts: {},
		onCancel() {},
		onSubmit() {},
	}));

	expect(markup).toContain(">A<");
	expect(markup).toContain(">B<");
	expect(markup.lastIndexOf("Add an option")).toBeGreaterThan(markup.indexOf("Team by team"));
	expect(markup).toContain(">Discard<");
	expect(markup).toContain(">Save<");
	expect(markup).not.toContain("Choose any");
	expect(markup).not.toContain("Write a custom answer");
});

test("an existing custom answer opens the add row as a field with the next letter", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [ROLLOUT] },
		drafts: { rollout: { mode: "custom", choice: "", options: {}, custom: "Opt-in beta" } },
	}));

	expect(markup).toContain("<textarea");
	expect(markup).toContain("Opt-in beta");
	expect(markup).toContain(">C<");
});

test("a multiple-choice question says so once, under its title", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [{ ...ROLLOUT, multiple: true }] },
		drafts: {},
	}));

	expect(markup.match(/Choose any/g)).toHaveLength(1);
	expect(markup).toContain('type="checkbox"');
});

test("several questions use a stepper, and only the last one saves", () => {
	let second = { ...ROLLOUT, id: "pilot", header: "Pilot team", question: "Who pilots it?" };
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [ROLLOUT, second] },
		drafts: {},
		onSubmit() {},
	}));

	expect(markup).not.toContain('role="tablist"');
	expect(markup).toContain("Rollout");
	expect(markup).toContain("1/2");
	expect(markup).toContain(">Next<");
	expect(markup).not.toContain(">Save<");
});

test("a failed save explains itself in a callout and offers another try", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [ROLLOUT] },
		drafts: {},
		error: "Check your connection and try again.",
		onSubmit() {},
	}));

	expect(markup).toContain("Couldn’t save");
	expect(markup).toContain("Check your connection and try again.");
	expect(markup).toContain('role="alert"');
	expect(markup).toContain("Try again");
});
