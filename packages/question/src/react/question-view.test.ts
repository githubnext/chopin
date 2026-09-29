import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { currentQuestion, QuestionView } from "./question-view";
import { create, limits, normalize, read } from "../index";

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

test("an existing custom answer still renders, as a selected row before the add row", () => {
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition: { questions: [ROLLOUT] },
		drafts: { rollout: { mode: "custom", choice: "", options: {}, custom: "Opt-in beta" } },
		onAddOption: async () => ({ ok: true as const }),
	}));

	expect(markup).not.toContain("<textarea");
	expect(markup).toContain("Opt-in beta");
	expect(markup).toContain(">C<");
	expect(markup.indexOf("Opt-in beta")).toBeLessThan(markup.lastIndexOf("Add an option"));
	expect(markup).toContain('checked=""');
});

test("the add row is disabled without a handler and hidden at the option limit", () => {
	let view = (options: typeof ROLLOUT.options, onAddOption?: () => Promise<{ ok: true }>) =>
		renderToStaticMarkup(createElement(QuestionView, {
			definition: { questions: [{ ...ROLLOUT, options }] },
			drafts: {},
			onAddOption,
		}));

	expect(view(ROLLOUT.options)).toMatch(/question-add"[^>]*disabled/);
	expect(view(ROLLOUT.options, async () => ({ ok: true }))).not.toMatch(
		/question-add"[^>]*disabled/,
	);

	let full = Array.from({ length: 10 }, (_, index) => ({
		id: `o${index}`,
		label: `Option ${index}`,
		description: "",
	}));
	expect(view(full, async () => ({ ok: true }))).not.toContain("Add an option");
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

function button(markup: string, label: string): string {
	let match = markup.match(new RegExp(`<button[^>]*>${label}</button>`));
	if (!match) throw new Error(`No ${label} button`);
	return match[0];
}

let ALL = { mode: "choices", choice: "all", options: {}, custom: "" } as const;

test("Save waits for an answer, and a blank custom answer is not one", () => {
	let render = (drafts: Parameters<typeof QuestionView>[0]["drafts"]) =>
		renderToStaticMarkup(createElement(QuestionView, {
			definition: { questions: [ROLLOUT] },
			drafts,
			onChange() {},
			onSubmit() {},
		}));

	expect(button(render({}), "Save")).toContain("disabled");
	expect(button(render({ rollout: { ...ALL, mode: "custom", choice: "", custom: "  " } }), "Save"))
		.toContain("disabled");
	expect(button(render({ rollout: ALL }), "Save")).not.toContain("disabled");
	expect(
		button(render({ rollout: { ...ALL, mode: "custom", choice: "", custom: "Beta" } }), "Save"),
	)
		.not.toContain("disabled");
});

test("Next waits for an answer to the current question, but not in a read-only view", () => {
	let second = { ...ROLLOUT, id: "pilot", header: "Pilot team", question: "Who pilots it?" };
	let definition = { questions: [ROLLOUT, second] };
	let editing = (drafts: Parameters<typeof QuestionView>[0]["drafts"]) =>
		renderToStaticMarkup(createElement(QuestionView, {
			definition,
			drafts,
			onChange() {},
			onSubmit() {},
		}));

	expect(button(editing({}), "Next")).toContain("disabled");
	expect(button(editing({ rollout: ALL }), "Next")).not.toContain("disabled");
	expect(button(
		renderToStaticMarkup(createElement(QuestionView, { definition, drafts: {} })),
		"Next",
	)).not.toContain("disabled");
});

test("a free-text host dialog renders an editable textarea without inventing a choice", () => {
	let definition = normalize({
		questions: [{ header: "Input", question: "Write the brief", options: [], multiple: false }],
	}, { verbatim: true });
	let markup = renderToStaticMarkup(createElement(QuestionView, {
		definition,
		drafts: read(create(definition), definition),
		onChange() {},
	}));
	expect(markup).toContain("<textarea");
	expect(markup).toContain("Write the brief");
	expect(markup).not.toContain('disabled=""');
});

test("only the Planner's own questions cap the custom answer textarea", () => {
	let question = { header: "Input", question: "Write the brief", multiple: false };
	for (
		let [definition, cap] of [
			[normalize({ questions: [{ ...question, options: [] }] }, { verbatim: true }), false],
			[
				normalize({ questions: [{ ...question, options: [{ label: "A", description: "" }] }] }),
				true,
			],
		] as const
	) {
		let drafts = read(create(definition), definition);
		drafts.q0!.mode = "custom";
		let markup = renderToStaticMarkup(createElement(QuestionView, {
			definition,
			drafts,
			onChange() {},
		}));
		expect(markup).toContain("<textarea");
		expect(markup.includes('maxLength="4000"')).toBe(cap);
	}
});

test("an expired card keeps its question and says the Planner will proceed; a withdrawn one does not", () => {
	let definition = normalize({
		questions: [{
			header: "Confirm",
			question: "Ship the migration?",
			options: [{ label: "Yes", description: "" }],
			multiple: false,
		}],
	});
	let render = (status: "expired" | "cancelled") =>
		renderToStaticMarkup(createElement(QuestionView, {
			definition,
			drafts: {},
			status,
			resolver: "chopin",
			onChange() {},
			onSubmit() {},
			onCancel() {},
		}));
	let note = `Nobody answered within ${limits.INPUT_EXPIRY_MS / 60_000} minutes. `
		+ "The Planner will use its best judgement for this decision.";
	let expired = render("expired");
	expect(limits.INPUT_EXPIRY_MS).toBe(30 * 60 * 1_000);
	expect(expired).toContain(
		"Nobody answered within 30 minutes. The Planner will use its best judgement for this decision.",
	);
	expect(expired).toContain(note);
	expect(expired).toContain("Ship the migration?");
	expect(expired).not.toContain("Cancelled");
	for (let control of ["<input", "<textarea", "<button"]) expect(expired).not.toContain(control);
	let withdrawn = render("cancelled");
	expect(withdrawn).toContain("Cancelled by @chopin");
	expect(withdrawn).not.toContain("Nobody answered");
});
