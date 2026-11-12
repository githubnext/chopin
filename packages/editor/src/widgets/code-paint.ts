/**
 * Where a block's coloured tokens fall in its text, and the text's places on the page.
 *
 * A code block is coloured where it is edited, as Notion's is: the highlighter's tokens are painted
 * over the source's own text with CSS Custom Highlights, one named highlight per role. Nothing is
 * written into the editor: the text stays Lexical's plain text children under Yjs, so typing,
 * merging and remote cursors are what they are in any paragraph. Kept apart from the plugin so the
 * arithmetic can be tested without a DOM.
 */

import type { CodeToken } from "./code-tokens";

/** A run of the source, by offset, that one role colours. */
export type Span = { role: string; start: number; end: number };

/** The coloured runs of a block's lines, by offset into the text the lines were read from. */
export function spans(lines: CodeToken[][]): Span[] {
	let found: Span[] = [];
	let at = 0;
	for (let [index, line] of lines.entries()) {
		if (index > 0) at += 1;
		for (let token of line) {
			let end = at + token.text.length;
			// Whitespace has no colour to show; a range for it is only work.
			if (token.role && token.text.trim()) found.push({ role: token.role, start: at, end });
			at = end;
		}
	}
	return found;
}

/** One piece of the source's DOM text: a text node, and the offset its first character has. */
type Piece = { node: Text; start: number };

/**
 * The source's text as the page holds it, or nothing while the page does not hold `text` yet.
 *
 * A line break is a `<br>` and counts as one character, as it does in the node's text; the
 * break Lexical adds after a last empty line is not text at all.
 */
export function pieces(source: HTMLElement, text: string): Piece[] | undefined {
	let found: Piece[] = [];
	let at = 0;
	let read = "";
	let walker = source.ownerDocument.createTreeWalker(
		source,
		NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node instanceof Text) {
			found.push({ node, start: at });
			at += node.data.length;
			read += node.data;
		} else if (
			node instanceof HTMLBRElement && !node.hasAttribute("data-lexical-managed-linebreak")
		) {
			at += 1;
			read += "\n";
		}
	}
	return read === text ? found : undefined;
}

/** The DOM ranges a block's spans cover. */
export function ranges(found: Piece[], painted: Span[]): Map<string, Range[]> {
	let byRole = new Map<string, Range[]>();
	let index = 0;
	let place = (offset: number, from: number): [number, Text, number] | undefined => {
		let at = from;
		while (at < found.length - 1 && found[at + 1]!.start <= offset) at++;
		let piece = found[at];
		if (!piece) return undefined;
		let local = offset - piece.start;
		if (local < 0 || local > piece.node.data.length) return undefined;
		return [at, piece.node, local];
	};
	for (let span of painted) {
		let start = place(span.start, index);
		if (!start) continue;
		index = start[0];
		// The end of a run is the end of its last character, never the start of the next piece.
		let end = place(span.end - 1, index);
		if (!end) continue;
		let range = new Range();
		range.setStart(start[1], start[2]);
		range.setEnd(end[1], end[2] + 1);
		let list = byRole.get(span.role) ?? [];
		list.push(range);
		byRole.set(span.role, list);
	}
	return byRole;
}
