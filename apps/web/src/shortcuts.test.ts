import { describe, expect, test } from "bun:test";

import {
	matchShortcut,
	shortcutKeys,
	shortcutLabel,
	shortcutPlatform,
	SHORTCUTS,
} from "./shortcuts";

import type { ShortcutContext, ShortcutKey } from "./shortcuts";

function key(value: string, modifiers: Partial<ShortcutKey> = {}): ShortcutKey {
	return {
		key: value,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...modifiers,
	};
}

let idle: ShortcutContext = { typing: false, modal: false };
let typing: ShortcutContext = { typing: true, modal: false };

describe("shortcut registry", () => {
	test("ids are unique", () => {
		let ids = SHORTCUTS.map(entry => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("no two live shortcuts share a chord", () => {
		let chords = SHORTCUTS.filter(entry => !entry.display).map(entry =>
			`${entry.mod}:${entry.shift}:${entry.key}`
		);
		expect(new Set(chords).size).toBe(chords.length);
	});

	test("live shortcuts avoid the editor's formatting and history chords", () => {
		// The editor claims ⌘K only for selected text; otherwise it falls through to search.
		let editor = SHORTCUTS.filter(entry => entry.display && entry.id !== "link").map(entry =>
			`${entry.shift}:${entry.key}`
		);
		for (let entry of SHORTCUTS.filter(entry => entry.mod && !entry.display)) {
			expect(editor).not.toContain(`${entry.shift}:${entry.key}`);
		}
	});
});

describe("platform", () => {
	test("Apple devices use the command key", () => {
		expect(shortcutPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
		expect(shortcutPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("mac");
		expect(shortcutPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("other");
		expect(shortcutPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
	});

	test("labels print keycaps for each platform", () => {
		expect(shortcutLabel("search", "mac")).toBe("⌘K");
		expect(shortcutLabel("search", "other")).toBe("Ctrl+K");
		expect(shortcutLabel("toggle-sidebar", "mac")).toBe("⌘\\");
		expect(shortcutLabel("new-document", "other")).toBe("C");
		expect(shortcutKeys("redo", "mac")).toEqual(["⌘", "⇧", "Z"]);
		expect(shortcutKeys("redo", "other")).toEqual(["Ctrl", "Shift", "Z"]);
	});
});

describe("matchShortcut", () => {
	test("matches the platform's modifier only", () => {
		expect(matchShortcut(key("k", { metaKey: true }), "mac", idle)).toBe("search");
		expect(matchShortcut(key("k", { ctrlKey: true }), "mac", idle)).toBeUndefined();
		expect(matchShortcut(key("k", { ctrlKey: true }), "other", idle)).toBe("search");
		expect(matchShortcut(key("k", { metaKey: true }), "other", idle)).toBeUndefined();
		expect(matchShortcut(key("k", { metaKey: true, ctrlKey: true }), "mac", idle))
			.toBeUndefined();
	});

	test("chords fire while typing; single keys do not", () => {
		expect(matchShortcut(key("k", { metaKey: true }), "mac", typing)).toBe("search");
		expect(matchShortcut(key(".", { metaKey: true }), "mac", typing)).toBe("toggle-chat");
		expect(matchShortcut(key("c"), "mac", typing)).toBeUndefined();
		expect(matchShortcut(key("?", { shiftKey: true }), "mac", typing)).toBeUndefined();
	});

	test("single keys fire outside fields", () => {
		expect(matchShortcut(key("c"), "mac", idle)).toBe("new-document");
		expect(matchShortcut(key("C", { shiftKey: true }), "mac", idle)).toBeUndefined();
		expect(matchShortcut(key("?", { shiftKey: true }), "mac", idle)).toBe("shortcuts");
	});

	test("matches the physical key when the layout cannot report an ASCII character", () => {
		expect(matchShortcut(key("Dead", { code: "Backslash", metaKey: true }), "mac", idle))
			.toBe("toggle-sidebar");
		expect(matchShortcut(key("\\", { metaKey: true }), "mac", idle)).toBe("toggle-sidebar");
	});

	test("Dvorak keeps the shortcuts its keys type, not the keys they sit on", () => {
		// ⌘V on Dvorak is the physical Period key; it must stay paste.
		expect(matchShortcut(key("v", { code: "Period", metaKey: true }), "mac", typing))
			.toBeUndefined();
		// ⌘. on Dvorak is the physical E key.
		expect(matchShortcut(key(".", { code: "KeyE", metaKey: true }), "mac", typing))
			.toBe("toggle-chat");
		expect(matchShortcut(key("k", { code: "KeyV", metaKey: true }), "mac", idle)).toBe("search");
	});

	test("AZERTY punctuation chords match the character they type, shifted or not", () => {
		// AZERTY types `.` with Shift on the `;` key.
		expect(
			matchShortcut(key(".", { code: "Comma", metaKey: true, shiftKey: true }), "mac", idle),
		).toBe("toggle-chat");
		// Its unshifted physical Period key types `:` and must not toggle Chat.
		expect(matchShortcut(key(":", { code: "Period", metaKey: true }), "mac", idle))
			.toBeUndefined();
		expect(matchShortcut(key("#", { code: "Backslash", metaKey: true }), "mac", idle))
			.toBeUndefined();
		expect(matchShortcut(key("?", { code: "KeyM", shiftKey: true }), "other", idle))
			.toBe("shortcuts");
		// AZERTY's A sits on the physical Q key; letters stay letters.
		expect(matchShortcut(key("k", { code: "KeyK", ctrlKey: true }), "other", idle)).toBe("search");
	});

	test("non-Latin layouts fall back to the physical key", () => {
		expect(matchShortcut(key("л", { code: "KeyK", metaKey: true }), "mac", idle)).toBe("search");
		expect(matchShortcut(key("ю", { code: "Period", metaKey: true }), "mac", idle))
			.toBe("toggle-chat");
	});

	test("an open modal, Alt, or composition suppresses every shortcut", () => {
		expect(matchShortcut(key("k", { metaKey: true }), "mac", { typing: false, modal: true }))
			.toBeUndefined();
		expect(matchShortcut(key("k", { metaKey: true, altKey: true }), "mac", idle))
			.toBeUndefined();
		expect(matchShortcut(key("c", { isComposing: true }), "mac", idle)).toBeUndefined();
	});

	test("editor chords are listed but never handled", () => {
		expect(matchShortcut(key("b", { metaKey: true }), "mac", typing)).toBeUndefined();
		expect(shortcutLabel("link", "mac")).toBe(shortcutLabel("search", "mac"));
		expect(matchShortcut(key("z", { metaKey: true, shiftKey: true }), "mac", typing))
			.toBeUndefined();
	});
});
