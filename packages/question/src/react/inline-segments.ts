export type InlineSegment = { code: boolean; text: string };

/**
 * Splits text on single-backtick pairs. Only inline code is recognised; an
 * unmatched or empty pair stays literal, and the stored text is never changed.
 */
export function inlineSegments(text: string): InlineSegment[] {
	let out: InlineSegment[] = [];
	let plain = "";
	let index = 0;
	while (index < text.length) {
		let open = text.indexOf("`", index);
		let close = open < 0 ? -1 : text.indexOf("`", open + 1);
		if (open < 0 || close < 0) break;
		if (close === open + 1) {
			plain += text.slice(index, close + 1);
			index = close + 1;
			continue;
		}
		plain += text.slice(index, open);
		if (plain) out.push({ code: false, text: plain });
		plain = "";
		out.push({ code: true, text: text.slice(open + 1, close) });
		index = close + 1;
	}
	plain += text.slice(index);
	if (plain) out.push({ code: false, text: plain });
	return out;
}

/** The text as read aloud or used in an accessible name: no code delimiters. */
export function plainInlineText(text: string): string {
	return inlineSegments(text).map(segment => segment.text).join("");
}
