/** A settled decision's one-line why: its bounds, its checks and the person's right to edit it. */

export const MAX_WHY = 300;

export type WhyCheck = { ok: true; text: string } | { ok: false; message: string };

/**
 * A person's why: a single line of plain text, trimmed. Empty is allowed and clears it, so the
 * caller decides what that means.
 */
export function personWhy(raw: unknown): WhyCheck {
	if (typeof raw !== "string") return { ok: false, message: "Write the reason as text" };
	let text = raw.trim();
	if (/[\r\n]/.test(text)) return { ok: false, message: "Keep it to one line" };
	if (text.length > MAX_WHY) {
		return { ok: false, message: `Keep it under ${MAX_WHY} characters` };
	}
	return { ok: true, text };
}

/**
 * Chopin's draft: exactly one plain sentence. Markdown and HTML markers, a second sentence and
 * an empty draft are refused so the tool call fails and the model repairs it.
 */
export function draftedWhy(raw: unknown): WhyCheck {
	let checked = personWhy(raw);
	if (!checked.ok) return { ok: false, message: `why: ${checked.message}` };
	let { text } = checked;
	if (!text) return { ok: false, message: "why must not be empty" };
	if (/[`*_#<>[\]|~]/.test(text) || /^[-+>\d]+[.)]?\s/.test(text)) {
		return { ok: false, message: "why must be plain text without Markdown" };
	}
	if (/[.!?]["')]*\s+\S/.test(text)) return { ok: false, message: "why must be one sentence" };
	return { ok: true, text };
}
