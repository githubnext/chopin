import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DecisionDialogContent, DecisionSummary } from "./decision-surface";

import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";

const value: Questionnaire = {
	id: "card-1",
	status: "decided",
	questions: [{
		id: "q1",
		header: "Authentication",
		prompt: "What auth system should we use?",
		multiple: false,
		options: [
			{ id: "auth0", label: "Auth0" },
			{ id: "github", label: "GitHub Apps" },
			{ id: "ours", label: "Roll our own" },
		],
		choices: ["github"],
		answer: "GitHub Apps",
	}],
};

const meta: Question.CardMeta = {
	status: "decided",
	origin: "conversation",
	thread: "thread-1",
	owner: "luna",
	decidedAt: new Date(2026, 8, 23, 17, 30).getTime() / 1_000,
	involved: ["luna", "maria", "tom"],
	history: [],
	optionOrigins: {},
	refining: false,
	hasProse: true,
	proseOrphaned: false,
};

describe("decided prose preview", () => {
	it("shows every option and marks the selected one", () => {
		let html = renderToStaticMarkup(<DecisionSummary meta={meta} value={value} />);

		expect(html).toContain("Auth0");
		expect(html).toContain("GitHub Apps");
		expect(html).toContain("Roll our own");
		expect(html).toMatch(/data-chosen="true"[^>]*>.*GitHub Apps/s);
		expect(html).toContain("Decided on Sep 23rd, 5:30pm");
	});

	it("keeps all options visible beside a custom answer", () => {
		let custom: Questionnaire = {
			...value,
			questions: [{ ...value.questions[0]!, choices: [], answer: "Use a managed passkey service" }],
		};
		let html = renderToStaticMarkup(<DecisionSummary meta={meta} value={custom} />);

		expect(html).toContain("Auth0");
		expect(html).toContain("GitHub Apps");
		expect(html).toContain("Roll our own");
		expect(html).toContain("Use a managed passkey service");
	});
});

describe("decided prose popover", () => {
	it("keeps full attribution when the avatar row is capped", () => {
		let people = ["luna", "maria", "tom", "sam", "alex", "jo", "mei", "lee", "ren", "kai", "maria"];
		let html = renderToStaticMarkup(
			<DecisionSummary full meta={{ ...meta, involved: people }} value={value} />,
		);

		expect(html).toContain("in discussion with maria, tom, sam, alex, jo, mei, lee, ren and kai");
		let faces = html.match(/class="plan-decision-faces">(.*?)<\/span>/s)?.[1];
		expect(faces?.match(/<img /g)).toHaveLength(8);
	});

	it("requires an inline confirmation and disables mutations while editing is unavailable", () => {
		let html = renderToStaticMarkup(
			<DecisionDialogContent
				confirming
				editable={false}
				meta={meta}
				onClose={() => {}}
				onDiscard={() => {}}
				onKeep={() => {}}
				onReopen={() => {}}
				value={value}
			/>,
		);

		expect(html).toContain("Discard this decision?");
		expect(html).toContain("Keep it");
		expect(html).toContain("Discard decision");
		expect(html).toMatch(/disabled=""[^>]*>Discard decision/);
	});
});
