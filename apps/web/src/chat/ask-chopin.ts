/**
 * Asking chopin is a mention in the draft's words. A message whose words mention `@chopin` outside
 * a reference asks the Planner, whether the mention was typed, chosen in the `@` menu, or put there
 * by the sparkle button or Command+J; one without it goes to the team. The server reads the same
 * words (`addressed` in `@chopin/protocol/address`), so the composer and the server never disagree.
 */

import { PLANNER_NAME } from "@chopin/editor/people";

import { addressedOutsideReferences, reconcileReferenceDrafts } from "./references";

import type { ChatSendPayload, ReferenceDraft } from "./references";

/** What the button and the chord write, as typing it would. */
const MENTION = `@${PLANNER_NAME}`;

/** Whether a message is for Chopin, which a document without an agent never is. */
export function asksChopin(
	{ agent, references, submitted, text }: {
		agent: boolean;
		text: string;
		references: ReadonlyArray<Pick<ReferenceDraft, "start" | "end" | "kind">>;
		/** Where a send already prepared from this draft is going. */
		submitted?: ChatSendPayload["to"];
	},
): boolean {
	return agent && (submitted === "planner" || addressedOutsideReferences(text, [...references]));
}

/**
 * The sparkle button and Command+J: `@chopin` in the draft, as if it were typed. It goes at the
 * caret when the field has one (`at`), and otherwise at the start, set apart by a space on each
 * side, with the caret after it. A caret inside a reference puts it after the reference. A draft
 * that already asks Chopin is left as it is, with the caret after its first mention (or at the end,
 * for a command, which is an address of its own).
 */
export function withChopinMention(
	text: string,
	references: ReferenceDraft[],
	at?: number,
): { text: string; references: ReferenceDraft[]; caret: number } {
	if (addressedOutsideReferences(text, references)) {
		let mention = [...text.matchAll(/(^|[^\w@])@chopin\b/gi)]
			.map(match => match.index + match[1]!.length)
			.find(start =>
				!references.some(reference =>
					start < reference.end && start + MENTION.length > reference.start
				)
			);
		if (mention === undefined) return { text, references, caret: text.length };
		let end = mention + MENTION.length;
		return { text, references, caret: text[end] === " " ? end + 1 : end };
	}
	let start = Math.min(Math.max(at ?? 0, 0), text.length);
	let inside = references.find(reference => reference.start < start && start < reference.end);
	if (inside) start = inside.end;
	let lead = start > 0 && !/\s/.test(text[start - 1]!) ? " " : "";
	let trail = text[start] === " " ? "" : " ";
	let next = text.slice(0, start) + lead + MENTION + trail + text.slice(start);
	return {
		text: next,
		references: reconcileReferenceDrafts(text, next, references, { start, end: start }),
		caret: start + lead.length + MENTION.length + 1,
	};
}

/** Command+J or Control+J asks Chopin from anywhere in the draft; nothing else is this rule's. */
export function asksChopinKey(event: {
	key: string;
	keyCode?: number;
	isComposing?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}): boolean {
	if (event.isComposing || event.keyCode === 229) return false;
	return event.key.toLowerCase() === "j" && !!(event.metaKey || event.ctrlKey)
		&& !event.shiftKey && !event.altKey;
}

/** What the empty draft says: the way to Chopin, where there is one. */
export function draftPlaceholder(agent: boolean): string {
	return agent ? `Message the team, or ${MENTION} to ask` : "Message the team";
}
