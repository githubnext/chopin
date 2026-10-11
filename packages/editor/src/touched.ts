import { useSyncExternalStore } from "react";

/**
 * Decision cards this person chose answers on, for the session.
 *
 * Kept outside the card so a remount (a tab switch, a reload) does not drop a
 * selection out of the save bar, which on a phone is the only way to save it.
 * Card ids are unique across documents. Storage can be unavailable, so it is
 * an optional mirror of the in-memory set rather than the source of truth.
 */
const KEY = "chopin:decisions:touched";

function load(): Set<string> {
	try {
		let stored = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown;
		return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

let cards: Set<string> | undefined;
let listeners = new Set<() => void>();

function current(): Set<string> {
	cards ??= load();
	return cards;
}

export function isTouched(card: string): boolean {
	return current().has(card);
}

export function setTouched(card: string, touched: boolean): void {
	let set = current();
	if (set.has(card) === touched) return;
	if (touched) set.add(card);
	else set.delete(card);
	try {
		sessionStorage.setItem(KEY, JSON.stringify([...set]));
	} catch {
		// Remembered for this page only.
	}
	for (let listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useTouched(card: string): boolean {
	return useSyncExternalStore(subscribe, () => isTouched(card), () => false);
}
