import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionView } from "./question-view";
import { AUTH } from "./question-view.test-fixtures";
import type { QuestionViewProps } from "./question-view";

let MULTIPLE = { questions: [{ ...AUTH.questions[0]!, multiple: true }] };

let LEGACY = {
	questions: [AUTH.questions[0]!, {
		id: "scope",
		header: "Scope",
		question: "What belongs in the first cut?",
		multiple: true,
		options: [{ id: "anchors", label: "Anchors", description: "" }],
	}],
};

function render(props: QuestionViewProps) {
	return renderToStaticMarkup(createElement(QuestionView, props));
}

for (let [name, definition] of [["single", AUTH], ["legacy multi", LEGACY]] as const) {
	test(`${name} discarded card names its questions and resolver without actions`, () => {
		let markup = render({
			definition,
			drafts: {},
			status: "discarded",
			resolver: "bea",
			onReopen: () => {},
			onDiscard: () => {},
		});
		expect(markup).toContain("Discarded by @bea");
		for (let question of definition.questions) expect(markup).toContain(question.question);
		expect(markup).not.toContain("Cancelled");
		expect(markup).not.toContain("Saved decision");
		expect(markup).not.toContain("<input");
		expect(markup).not.toContain("<button");
	});
}

test("system discarded cards name the question without attributing a person", () => {
	for (let resolver of [undefined, "system"]) {
		let markup = render({ definition: AUTH, drafts: {}, status: "discarded", resolver });
		expect(markup).toContain("Discarded");
		expect(markup).toContain(AUTH.questions[0]!.question);
		expect(markup).not.toContain("@system");
		expect(markup).not.toContain("Answered");
	}
});

test("genuine cancellation keeps its existing summary and has no resolved actions", () => {
	let markup = render({
		definition: AUTH,
		drafts: {},
		status: "cancelled",
		resolver: "bea",
		onReopen: () => {},
		onDiscard: () => {},
	});
	expect(markup).toContain("Cancelled by @bea");
	expect(markup).not.toContain("Discarded");
	expect(markup).not.toContain("<input");
	expect(markup).not.toContain("<button");
	let system = render({ definition: AUTH, drafts: {}, status: "cancelled", resolver: "system" });
	expect(system).toContain("Cancelled — the question was never answered.");
	expect(system).not.toContain("@system");
});

test("only the untouched projected suggestion row is labelled from chat without changing drafts", () => {
	let drafts = {
		q: { mode: "choices" as const, choice: null, options: { a: false, b: false }, custom: "" },
	};
	let before = structuredClone(drafts);
	let markup = render({ definition: AUTH, drafts, suggested: { optionId: "b", revision: 7 } });
	expect(markup.match(/from chat/g)).toHaveLength(1);
	expect(markup).toMatch(/GitHub Apps[\s\S]*?from chat/);
	expect(markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ")).toContain("GitHub Apps from chat");
	expect(markup).toMatch(/<input[^>]*checked=""[^>]*\/>/);
	expect(drafts).toEqual(before);
});

test("human choices and custom answers do not inherit suggestion provenance", () => {
	for (
		let draft of [
			{ mode: "choices" as const, choice: "a", options: { a: true, b: false }, custom: "" },
			{
				mode: "custom" as const,
				choice: null,
				options: { a: false, b: false },
				custom: "A third approach",
			},
		]
	) {
		let before = structuredClone(draft);
		let markup = render({
			definition: AUTH,
			drafts: { q: draft },
			suggested: { optionId: "b", revision: 7 },
		});
		expect(markup).not.toContain("from chat");
		expect(draft).toEqual(before);
	}
});

test("invalid and multi-question suggestions never gain a from chat label", () => {
	for (let [definition, optionId] of [[AUTH, "missing"], [LEGACY, "b"], [MULTIPLE, "b"]] as const) {
		let markup = render({ definition, drafts: {}, suggested: { optionId, revision: 7 } });
		expect(markup).not.toContain("from chat");
	}
});
