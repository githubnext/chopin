/**
 * How a question's text reads on a card.
 *
 * A question is Markdown. Its first line is the card's heading and anything
 * after that line is the body under it, so an agent can ask a short question
 * and still show a list, a diagram or an image beneath it. Text with no line
 * break is a heading alone, exactly as every earlier question was. The stored
 * text is never changed: this only says which part goes where.
 */
export type QuestionParts = { heading: string; body?: string };

export function questionParts(text: string): QuestionParts {
	let source = text.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "");
	let end = source.indexOf("\n");
	if (end < 0) return { heading: source.trim() };
	let heading = source.slice(0, end).trim();
	let body = source.slice(end + 1).replace(/^\s*\n/, "").trimEnd();
	return body ? { heading, body } : { heading };
}

/** The heading alone, for a row, label or announcement with room for one line. */
export function questionHeading(text: string): string {
	return questionParts(text).heading;
}

/** Whether text holds more than one line, and so reads as Markdown blocks rather than a phrase. */
export function multiline(text: string): boolean {
	return /\n/.test(text.trim());
}
