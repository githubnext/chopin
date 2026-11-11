/**
 * The marks of the message box's formatting toolbar: pure edits of the draft's text, since Chat
 * messages are Markdown. Each takes the draft and its selection and says the new text, where the
 * selection is after it, and the range of the old text the change replaced (so the references
 * outside it are kept).
 */

export type Format =
	| "bold"
	| "italic"
	| "strike"
	| "link"
	| "numbered"
	| "bulleted"
	| "code"
	| "block";

export type Selection = { start: number; end: number };

export type Formatted = {
	text: string;
	start: number;
	end: number;
	/** What the new text replaces, as a range of the old. */
	edit: Selection;
};

const MARKS = { bold: "**", italic: "_", strike: "~~", code: "`" } as const;

/** The text from `edit` on, with `replacement` in its place: how a result is built from the old. */
function replaced(
	text: string,
	edit: Selection,
	replacement: string,
	start: number,
	end: number,
): Formatted {
	return {
		text: text.slice(0, edit.start) + replacement + text.slice(edit.end),
		start: edit.start + start,
		end: edit.start + end,
		edit,
	};
}

function wrap(mark: string, text: string, { start, end }: Selection): Formatted {
	let before = text.slice(start - mark.length, start);
	let after = text.slice(end, end + mark.length);
	// Marks already round the selection come off again.
	if (start !== end && before === mark && after === mark) {
		return replaced(
			text,
			{ start: start - mark.length, end: end + mark.length },
			text.slice(start, end),
			0,
			end - start,
		);
	}
	let inside = text.slice(start, end);
	return replaced(
		text,
		{ start, end },
		`${mark}${inside}${mark}`,
		mark.length,
		mark.length + inside.length,
	);
}

function link(text: string, { start, end }: Selection): Formatted {
	let label = start === end ? "text" : text.slice(start, end);
	let words = `[${label}](url)`;
	// The address is what is typed next; with no words selected, they are.
	return start === end
		? replaced(text, { start, end }, words, 1, 1 + label.length)
		: replaced(text, { start, end }, words, label.length + 3, label.length + 6);
}

const NUMBERED = /^\d+\. /;
const BULLETED = /^- /;

function list(kind: "numbered" | "bulleted", text: string, { start, end }: Selection): Formatted {
	let from = text.lastIndexOf("\n", start - 1) + 1;
	let to = text.indexOf("\n", end);
	if (to === -1) to = text.length;
	let lines = text.slice(from, to).split("\n");
	let marked = kind === "numbered" ? NUMBERED : BULLETED;
	let off = lines.every(line => marked.test(line));
	let result = lines.map((line, index) =>
		off
			? line.replace(marked, "")
			: `${kind === "numbered" ? `${index + 1}. ` : "- "}${
				line.replace(NUMBERED, "").replace(BULLETED, "")
			}`
	).join("\n");
	return replaced(text, { start: from, end: to }, result, 0, result.length);
}

function block(text: string, { start, end }: Selection): Formatted {
	let lead = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
	let inside = text.slice(start, end);
	let opening = `${lead}\`\`\`\n`;
	return replaced(
		text,
		{ start, end },
		`${opening}${inside}\n\`\`\``,
		opening.length,
		opening.length + inside.length,
	);
}

export function applyFormat(kind: Format, text: string, selection: Selection): Formatted {
	if (kind === "link") return link(text, selection);
	if (kind === "numbered" || kind === "bulleted") return list(kind, text, selection);
	if (kind === "block") return block(text, selection);
	return wrap(MARKS[kind], text, selection);
}
