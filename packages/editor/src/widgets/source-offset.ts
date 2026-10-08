/**
 * Where in a block's source a gesture on its preview should put the caret.
 *
 * A preview is a second, derived drawing of the source, so a place in it only
 * maps back when the drawing keeps the source's lines. Coloured code does, one
 * for one. A rendered patch keeps every line but drops its first column, so a
 * line is found again by its kind and its text. Anything that cannot be found
 * says so, and the caller falls back to the end.
 */

/** The offset of a column on a line, clamped to that line. */
export function offsetOfLine(source: string, line: number, column = 0): number | undefined {
	let lines = source.split("\n");
	if (line < 0 || line >= lines.length) return undefined;
	let start = 0;
	for (let index = 0; index < line; index++) start += lines[index]!.length + 1;
	return start + Math.max(0, Math.min(column, lines[line]!.length));
}

/** Where the last line starts, for arriving at a block from below. */
export function lastLineStart(source: string): number {
	return source.lastIndexOf("\n") + 1;
}

const MARKS: Record<string, string> = {
	context: " ",
	"change-addition": "+",
	"change-deletion": "-",
};

/**
 * Which source line a drawn diff line came from.
 *
 * `occurrence` counts the identical drawn lines before this one, so two equal
 * context lines in different hunks each find their own.
 */
export function diffSourceLine(
	source: string,
	type: string,
	text: string,
	occurrence: number,
): number | undefined {
	let mark = MARKS[type];
	if (mark === undefined) return undefined;
	let wanted = mark + text;
	let seen = 0;
	let lines = source.split("\n");
	for (let [index, line] of lines.entries()) {
		// An empty context line is often written with its space trimmed.
		let matches = line === wanted || (mark === " " && text === "" && line === "");
		if (!matches) continue;
		if (seen === occurrence) return index;
		seen++;
	}
	return undefined;
}
