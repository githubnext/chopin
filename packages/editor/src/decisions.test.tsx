import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Decisions } from "./decisions";
import { QuestionnaireStore } from "./questionnaires";

let original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function markup(stored?: string): string {
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
	store.set({
		entries: [{
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
		}],
		hasPlanContent: true,
	});
	return renderToStaticMarkup(createElement(Decisions, { store }));
}

test("resolved history starts collapsed and restores an explicit open preference", () => {
	expect(markup()).toContain('aria-expanded="false"');
	expect(markup("true")).toContain('aria-expanded="true"');
});
