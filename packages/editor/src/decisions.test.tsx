import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Decisions } from "./decisions";
import { QuestionnaireStore } from "./questionnaires";

import type { MotionDisclosureContract } from "./disclosure-motion";
import type { QuestionnaireEntry } from "./questionnaires";

let original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

const RESOLVED: QuestionnaireEntry = {
	id: "questionnaire",
	value: {
		id: "questionnaire",
		questions: [{
			id: "question",
			header: "Question",
			prompt: "What did the room decide?",
			multiple: false,
			options: [],
			answer: "Done",
		}],
	},
};

afterEach(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function markup(stored?: string, entries = [RESOLVED], failed = false): string {
	let values = new Map<string, string>();
	if (stored) values.set("chopin:decisions:resolved", stored);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		},
	});

	let store = new QuestionnaireStore();
	store.set({ entries, hasPlanContent: true });
	if (failed) store.failOpen();
	let motion: MotionDisclosureContract = {
		className: "motion-collapse",
		closeDuration: 250,
		contentClassName: "motion-collapse-content",
	};
	return renderToStaticMarkup(createElement(Decisions, { motion, store }));
}

test("resolved history starts collapsed and restores an explicit open preference", () => {
	let collapsed = markup();
	expect(collapsed).toContain('aria-expanded="false"');
	expect(collapsed).not.toContain("aria-controls");
	expect(collapsed).toContain('data-feedback-icon="closed"');
	expect(collapsed).toContain('data-motion-feedback="icon"');
	let restored = markup("true");
	expect(restored).toContain('aria-expanded="true"');
	expect(restored).toMatch(/aria-controls="[^"]+"/);
	expect(restored).toContain('data-motion-disclosure="decision-history"');
	expect(restored).toContain('data-feedback-icon="open"');
	expect(restored).toContain('data-motion-feedback="icon"');
});

test("an expired card is listed with the resolved cards and says nobody answered", () => {
	let expired: QuestionnaireEntry = {
		id: "expired",
		value: {
			id: "expired",
			status: "expired",
			at: "2026-09-28T10:30:00.000Z",
			questions: [{
				id: "confirm",
				header: "Confirm",
				prompt: "Ship the migration?",
				multiple: false,
				options: [{ id: "yes", label: "Yes" }],
			}],
		},
	};
	let history = markup("true", [expired, RESOLVED]);
	expect(history).toMatch(/<span class="tabular-nums">2<\/span><span>resolved<\/span>/);
	expect(history).toContain('data-plan-sidecar-questionnaire="expired"');
	expect(history).toContain("Ship the migration?");
	expect(history).toContain(
		"Nobody answered within 30 minutes. The Planner will use its best judgement for this decision.",
	);
	for (let control of ["Save answer", "<textarea", 'type="radio"']) {
		expect(history).not.toContain(control);
	}
});

test("an unsynced empty snapshot does not claim there are no decisions", () => {
	let loading = markup(undefined, []);
	expect(loading).toContain("Loading decisions…");
	expect(loading).not.toContain("No decisions yet");
	expect(loading).toContain('aria-live="polite"');
	expect(loading).toContain('role="status"');
});

test("a failed document open offers a retry instead of indefinite loading", () => {
	let failed = markup(undefined, [], true);
	expect(failed).toContain("Decisions unavailable");
	expect(failed).toContain("Try again");
	expect(failed).not.toContain("Loading decisions…");
});
