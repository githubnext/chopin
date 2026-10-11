import { useSyncExternalStore } from "react";

import type { Question } from "@chopin/protocol";

/**
 * The answers this person chose on each decision card, for the session.
 *
 * Kept outside the card so a remount (a tab switch, a reload) does not drop a
 * selection out of the save bar, which on a phone is the only way to save it.
 * What is kept is the selection itself, not a flag: a card counts as this
 * person's only while the shared draft still says what they chose, so a
 * collaborator's later change is never saved under their name from the bar.
 * Card ids are unique across documents. Storage can be unavailable, so it is
 * an optional mirror of the in-memory map rather than the source of truth.
 */
const KEY = "chopin:decisions:selections";

type Draft = Question.DraftAnswer;
export type Selections = Readonly<Record<string, string>>;

/** One question's selection as comparable text. */
export function selectionOf(draft: Draft | undefined): string {
	if (!draft) return "";
	if (draft.mode === "custom") return `t:${draft.custom.trim()}`;
	let options = Object.keys(draft.options).filter(option => draft.options[option]).sort();
	return `c:${draft.choice ?? ""}|o:${options.join(",")}`;
}

/** The draft as it will be once a local change lands, as the controller applies it. */
export function withChange(draft: Draft | undefined, change: Partial<Draft>): Draft {
	let base: Draft = draft ?? { mode: "choices", choice: null, options: {}, custom: "" };
	let choosing = change.choice !== undefined || change.options !== undefined;
	return {
		...base,
		...change,
		mode: choosing ? "choices" : change.mode ?? base.mode,
		options: { ...base.options, ...change.options },
	};
}

/** Whether the shared draft still holds exactly what this person chose. */
export function stillMine(
	selections: Selections | undefined,
	drafts: Readonly<Record<string, Draft>>,
): boolean {
	if (!selections) return false;
	let questions = Object.keys(selections);
	return questions.length > 0
		&& questions.every(question => selections[question] === selectionOf(drafts[question]));
}

function load(): Map<string, Selections> {
	try {
		let stored = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as unknown;
		if (!stored || typeof stored !== "object" || Array.isArray(stored)) return new Map();
		return new Map(
			Object.entries(stored as Record<string, unknown>).flatMap(([card, value]) =>
				value && typeof value === "object" && !Array.isArray(value)
					? [[card, value as Selections] as const]
					: []
			),
		);
	} catch {
		return new Map();
	}
}

let cards: Map<string, Selections> | undefined;
let listeners = new Set<() => void>();

function current(): Map<string, Selections> {
	cards ??= load();
	return cards;
}

function publish() {
	try {
		sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(current())));
	} catch {
		// Remembered for this page only.
	}
	for (let listener of listeners) listener();
}

export function selectionsFor(card: string): Selections | undefined {
	return current().get(card);
}

/** This person chose an answer to one question on the card. */
export function remember(card: string, question: string, selection: string): void {
	let previous = current().get(card);
	if (previous?.[question] === selection) return;
	current().set(card, { ...previous, [question]: selection });
	publish();
}

/** Nothing of this person's is left to save on the card. */
export function forget(card: string): void {
	if (current().delete(card)) publish();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSelections(card: string): Selections | undefined {
	return useSyncExternalStore(subscribe, () => selectionsFor(card), () => undefined);
}
