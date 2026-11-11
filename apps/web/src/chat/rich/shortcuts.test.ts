import { describe, expect, it } from "bun:test";

import { formatShortcut, typedBlock, typedInline } from "./shortcuts";

import type { KeyChord } from "./shortcuts";

function chord(code: string, modifiers: Partial<KeyChord> = {}): KeyChord {
	return {
		key: "",
		code,
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: true,
		...modifiers,
	};
}

describe("Slack's formatting keys", () => {
	it("format with Cmd on a Mac and Ctrl elsewhere", () => {
		expect(formatShortcut(chord("KeyB"))).toBe("bold");
		expect(formatShortcut(chord("KeyB", { metaKey: false, ctrlKey: true }))).toBe("bold");
		expect(formatShortcut(chord("KeyI"))).toBe("italic");
		expect(formatShortcut(chord("KeyX", { shiftKey: true }))).toBe("strike");
		expect(formatShortcut(chord("Digit7", { shiftKey: true }))).toBe("numbered");
		expect(formatShortcut(chord("Digit8", { shiftKey: true }))).toBe("bulleted");
		expect(formatShortcut(chord("KeyC", { shiftKey: true }))).toBe("code");
		expect(formatShortcut(chord("KeyC", { shiftKey: true, altKey: true }))).toBe("block");
		expect(formatShortcut(chord("KeyK"))).toBe("link");
		// Markdown has no underline, so the key is taken and does nothing.
		expect(formatShortcut(chord("KeyU"))).toBe("underline");
	});

	it("leave every other chord alone", () => {
		expect(formatShortcut(chord("KeyB", { metaKey: false }))).toBeUndefined();
		expect(formatShortcut(chord("KeyX"))).toBeUndefined();
		expect(formatShortcut(chord("KeyC"))).toBeUndefined();
		expect(formatShortcut(chord("KeyJ"))).toBeUndefined();
		expect(formatShortcut(chord("KeyM", { shiftKey: true, altKey: true }))).toBeUndefined();
		expect(formatShortcut(chord("KeyB", { ctrlKey: true }))).toBeUndefined();
	});
});

describe("Slack's typed formatting", () => {
	it("formats the words between two marks once the closing one is typed", () => {
		expect(typedInline("say *bold*")).toEqual({ format: "bold", open: 4, close: 9, length: 1 });
		expect(typedInline("**bold**")).toEqual({ format: "bold", open: 0, close: 6, length: 2 });
		expect(typedInline("_it_")).toEqual({ format: "italic", open: 0, close: 3, length: 1 });
		expect(typedInline("(~gone~")).toEqual({ format: "strike", open: 1, close: 6, length: 1 });
		expect(typedInline("~~gone~~")).toEqual({ format: "strike", open: 0, close: 6, length: 2 });
		expect(typedInline("run `a b`")).toEqual({ format: "code", open: 4, close: 8, length: 1 });
	});

	it("leaves marks that close nothing as they are typed", () => {
		// The first star of a closing `**` waits for the second.
		expect(typedInline("**bold*")).toBeUndefined();
		expect(typedInline("2 * 3 *")).toBeUndefined();
		expect(typedInline("snake_case_")).toBeUndefined();
		expect(typedInline("a*b*")).toBeUndefined();
		expect(typedInline("**")).toBeUndefined();
		expect(typedInline("``")).toBeUndefined();
		expect(typedInline("```")).toBeUndefined();
		expect(typedInline("plain")).toBeUndefined();
	});

	it("starts lists and code blocks from the marks at the start of a line", () => {
		expect(typedBlock("- ")).toEqual({ kind: "bulleted" });
		expect(typedBlock("* ")).toEqual({ kind: "bulleted" });
		expect(typedBlock("1. ")).toEqual({ kind: "numbered", start: 1 });
		expect(typedBlock("4. ")).toEqual({ kind: "numbered", start: 4 });
		expect(typedBlock("```")).toEqual({ kind: "block" });
		expect(typedBlock("a - ")).toBeUndefined();
		expect(typedBlock("1.")).toBeUndefined();
		expect(typedBlock("-")).toBeUndefined();
	});
});
