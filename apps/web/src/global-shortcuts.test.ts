import { afterEach, expect, test } from "bun:test";

import { listenForShortcuts } from "./global-shortcuts";

type Key = { key: string; code: string; altKey?: boolean; target?: unknown };

let saved = {
	window: globalThis.window,
	document: globalThis.document,
	Element: globalThis.Element,
};

/** An element inside the document being written, which `closest` finds editable. */
class Editable {
	closest() {
		return this;
	}
}
afterEach(() => {
	Object.assign(globalThis, saved);
});

/**
 * The window's key listener, over a document that counts its searches for an open dialog. `modal`
 * says whether that search finds one.
 */
function listen(modal: boolean): { press: (key: Key) => boolean; searches: () => number } {
	let listener: ((event: KeyboardEvent) => void) | undefined;
	let searches = 0;
	Object.assign(globalThis, {
		Element: Editable,
		window: {
			addEventListener: (_type: string, handler: (event: KeyboardEvent) => void) => {
				listener = handler;
			},
			removeEventListener: () => {},
		},
		document: {
			querySelectorAll: () => {
				searches++;
				return modal ? [{ closest: () => null }] : [];
			},
		},
	});
	let ran = false;
	listenForShortcuts(() => ({ "new-document": () => (ran = true) }));
	return {
		press: key => {
			ran = false;
			listener!({
				altKey: false,
				ctrlKey: false,
				defaultPrevented: false,
				isComposing: false,
				metaKey: false,
				preventDefault: () => {},
				repeat: false,
				shiftKey: false,
				target: null,
				...key,
			} as unknown as KeyboardEvent);
			return ran;
		},
		searches: () => searches,
	};
}

test("a key typed into a document never searches the page for an open dialog", () => {
	let keys = listen(false);
	let target = new Editable();
	for (let key of "and the gateway forwards") {
		keys.press({ key, code: `Key${key.toUpperCase()}`, target });
	}
	// On a long document each search read every element, on every key.
	expect(keys.searches()).toBe(0);
});

test("a shortcut still runs, and still waits while a dialog is open", () => {
	expect(listen(false).press({ key: "n", code: "KeyN", altKey: true })).toBe(true);

	let covered = listen(true);
	expect(covered.press({ key: "n", code: "KeyN", altKey: true })).toBe(false);
	expect(covered.searches()).toBe(1);
});
