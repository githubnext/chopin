export type InlineSegment = { code: boolean; text: string };

function run(text: string, from: number): number {
	let end = from;
	while (text[end] === "`") end++;
	return end - from;
}

/**
 * Splits text into prose and inline code using CommonMark code-span rules: a span
 * opens with a backtick run of length N and closes at the next run of exactly N.
 * An unmatched run stays literal, one space is trimmed from each side when the
 * content has both, and whitespace-only content stays literal. Outside a span
 * a backslash-escaped backtick is a literal backtick; inside one, backslashes
 * are literal. The stored text is never changed.
 */
export function inlineSegments(text: string): InlineSegment[] {
	let out: InlineSegment[] = [];
	let plain = "";
	let index = 0;
	let flush = () => {
		if (plain) out.push({ code: false, text: plain });
		plain = "";
	};
	while (index < text.length) {
		let char = text[index]!;
		if (char === "\\" && text[index + 1] === "`") {
			plain += "`";
			index += 2;
			continue;
		}
		if (char !== "`") {
			plain += char;
			index++;
			continue;
		}
		let size = run(text, index);
		let start = index + size;
		let close = -1;
		for (let cursor = start; cursor < text.length;) {
			if (text[cursor] !== "`") {
				cursor++;
				continue;
			}
			let length = run(text, cursor);
			if (length === size) {
				close = cursor;
				break;
			}
			cursor += length;
		}
		if (close < 0) {
			plain += text.slice(index, start);
			index = start;
			continue;
		}
		let content = text.slice(start, close);
		if (!content.trim()) {
			plain += text.slice(index, close + size);
		} else {
			if (content.startsWith(" ") && content.endsWith(" ")) content = content.slice(1, -1);
			flush();
			out.push({ code: true, text: content });
		}
		index = close + size;
	}
	flush();
	return out;
}

/** The text as read aloud or used in an accessible name: no code delimiters. */
export function plainInlineText(text: string): string {
	return inlineSegments(text).map(segment => segment.text).join("");
}

/** Joins items after reading each one on its own, so delimiters never pair across items. */
export function plainInlineList(items: string[], separator = ", "): string {
	return items.map(plainInlineText).join(separator);
}
