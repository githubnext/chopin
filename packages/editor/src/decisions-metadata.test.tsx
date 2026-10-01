import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CardMetaStore } from "./card-meta";
import { Decisions } from "./decisions";
import { QuestionnaireStore } from "./questionnaires";
import { DECIDED, META } from "./widgets/questionnaire-metadata.test-fixtures";
import type { Question } from "@chopin/protocol";
import type { Transport } from "./transport";

let original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function markup(meta?: Question.CardMeta, canEdit?: boolean) {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null, setItem() {} },
	});
	let store = new QuestionnaireStore();
	store.set({ entries: [{ id: DECIDED.id, value: DECIDED }], hasPlanContent: true });
	let cardMeta = new CardMetaStore(() => {});
	let handlers = new Map<string, (frame: never) => void>();
	let wire: Transport = {
		on: (kind, handler) => {
			handlers.set(kind, handler as never);
			return () => handlers.delete(kind);
		},
		send() {},
		ask: async () => ({}) as never,
	};
	cardMeta.listen(wire);
	if (meta) handlers.get("question:meta")?.({ id: DECIDED.id, meta } as never);
	return renderToStaticMarkup(createElement(Decisions, {
		store,
		cardMeta,
		canEdit,
		connected: true,
		motion: {
			className: "motion-collapse",
			closeDuration: 250,
			contentClassName: "motion-collapse-content",
		},
	}));
}

test("reopened metadata moves an answered node out of collapsed history", () => {
	let html = markup({ ...META, status: "reopened" });
	expect(html).toContain("<input");
	expect(html).not.toContain('aria-expanded="false"');
});

test("decided and absent metadata keep the existing collapsed history", () => {
	for (let meta of [META, undefined]) {
		let html = markup(meta);
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("<input");
	}
});

test("standalone Decisions retains its editable default while explicit read-only suppresses actions", () => {
	let meta = { ...META, status: "reopened" as const };
	let writable = markup(meta, undefined);
	let readOnly = markup(meta, false);
	expect(writable).toContain(">Save<");
	expect(writable).toContain("Cancel");
	expect(readOnly).not.toContain(">Save<");
	expect(readOnly).not.toContain("Cancel");
});
