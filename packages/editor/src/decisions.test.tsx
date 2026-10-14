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
	store.set({ entries, hasPlanContent: true, runs: [] });
	if (failed) store.failOpen();
	let motion: MotionDisclosureContract = {
		className: "motion-collapse",
		closeDuration: 250,
		contentClassName: "motion-collapse-content",
	};
	return renderToStaticMarkup(createElement(Decisions, { motion, store }));
}

test("resolved history opens by default, including after a previously saved collapse", () => {
	for (let stored of [undefined, "false", "true"]) {
		let html = markup(stored);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toMatch(/aria-controls="[^"]+"/);
		expect(html).toContain('data-slot="unfold-section"');
		expect(html).toContain('data-plan-sidecar-questionnaire="questionnaire"');
	}
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
	expect(history).toContain("2 resolved");
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

function openEntry(id: string, header: string): QuestionnaireEntry {
	return {
		id,
		value: {
			id,
			questions: [{ id: `${id}-q`, header, prompt: `${header}?`, multiple: false, options: [] }],
		},
	};
}

test("two open decisions render as a desktop deck above resolved history", () => {
	let html = markup(undefined, [openEntry("a", "Storage"), openEntry("b", "Scope"), RESOLVED]);
	expect(html).toContain('aria-roledescription="carousel"');
	expect(html).toContain('aria-label="2 open decisions"');
	expect(html).toContain("1 of 2");
	expect(html.indexOf("data-deck=")).toBeLessThan(html.indexOf("1 resolved"));
	expect(html).not.toContain("decision-save-bar");
});

test("one open decision renders without a deck", () => {
	expect(markup(undefined, [openEntry("a", "Storage")])).not.toContain("data-deck");
});
