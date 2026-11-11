/**
 * Slack's shortcuts for the Chat draft, as pure rules: the keys that format (Cmd or Ctrl with B,
 * I, Shift+X, Shift+7, Shift+8, Shift+C, Alt+Shift+C and K), and the marks that format as they are
 * typed (`*bold*`, `_italic_`, `~strike~`, `` `code` ``, ``` for a code block, `- ` and `1. ` for
 * lists).
 */

import { SHORTCUTS } from "../../shortcuts";

import type { ShortcutId } from "../../shortcuts";
import type { Format } from "../format";

export type KeyChord = {
	key: string;
	code: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
};

/** The registry's chords that format the draft, and the format each applies. */
export const FORMAT_SHORTCUTS: ReadonlyArray<[ShortcutId, Format]> = [
	["bold", "bold"],
	["italic", "italic"],
	["strikethrough", "strike"],
	["link", "link"],
	["numbered-list", "numbered"],
	["bulleted-list", "bulleted"],
	["code", "code"],
	["code-block", "block"],
];

/**
 * The format a key chord applies, read from the one registry of chords by the physical key, so
 * Shift+7 is the numbered list whatever the layout prints on it; or `underline`, which Markdown has
 * no mark for and is refused.
 */
export function formatShortcut(event: KeyChord): Format | "underline" | undefined {
	if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return undefined;
	if (event.code === "KeyU" && !event.shiftKey && !event.altKey) return "underline";
	for (let [id, format] of FORMAT_SHORTCUTS) {
		let entry = SHORTCUTS.find(shortcut => shortcut.id === id)!;
		let code = entry.code ?? `Key${entry.key.toUpperCase()}`;
		if (event.code === code && !!entry.shift === event.shiftKey && !!entry.alt === event.altKey) {
			return format;
		}
	}
	return undefined;
}

export type InlineMark = "bold" | "italic" | "strike" | "code";

/**
 * The marks typed round words that format them once the closing mark is typed, as Slack reads them:
 * `*` is bold (and `**`, which Markdown habit types), `_` italic, `~` and `~~` struck, and a
 * backtick code.
 */
const MARKS: Array<{ mark: string; format: InlineMark }> = [
	{ mark: "**", format: "bold" },
	{ mark: "~~", format: "strike" },
	{ mark: "*", format: "bold" },
	{ mark: "_", format: "italic" },
	{ mark: "~", format: "strike" },
	{ mark: "`", format: "code" },
];

export type TypedInline = {
	format: InlineMark;
	/** Where the opening mark starts, and how long each mark is. */
	open: number;
	/** Where the closing mark starts; it ends where the caret is. */
	close: number;
	length: number;
};

/**
 * Whether the text before the caret, which ends with the character just typed, closes a typed
 * format: words between an opening and a closing mark, touching neither with a space (code may),
 * after the start, a space or punctuation. `**` waits for its second star, so `*` never closes the
 * first of two.
 */
export function typedInline(before: string): TypedInline | undefined {
	for (let { mark, format } of MARKS) {
		if (!before.endsWith(mark)) continue;
		let close = before.length - mark.length;
		// The first star of a closing `**` is not a closing `*` yet.
		if (mark.length === 1 && before[close - 1] === mark) continue;
		let open = before.lastIndexOf(mark, close - 1);
		if (open < 0) continue;
		let inside = before.slice(open + mark.length, close);
		let preceding = before[open - 1];
		let doubled = mark.length === 1 && (preceding === mark || before[open + 1] === mark);
		if (
			inside && !inside.includes(mark[0]!)
			&& (format === "code" || (!/^\s/.test(inside) && !/\s$/.test(inside)))
			&& (preceding === undefined || /[\s\p{P}\p{S}]/u.test(preceding)) && !doubled
		) return { format, open, close, length: mark.length };
	}
	return undefined;
}

export type TypedBlock =
	| { kind: "bulleted" }
	| { kind: "numbered"; start: number }
	| { kind: "block" };

/** Whether what a line holds before the caret, just typed, starts a list or a code block. */
export function typedBlock(line: string): TypedBlock | undefined {
	if (line === "- " || line === "* ") return { kind: "bulleted" };
	let numbered = /^(\d{1,9})\. $/.exec(line);
	if (numbered) return { kind: "numbered", start: Number(numbered[1]) };
	if (line === "```") return { kind: "block" };
	return undefined;
}
