/**
 * The Chopin chip: who a message is for, as a person sees and changes it.
 *
 * A message goes to the team, or, with the chip at the start of the draft, asks Chopin. The chip is
 * the state; it is not in the draft's words, so these rules only say when it is on, which keys
 * change it, and what choosing Chopin in the `@` menu does to the draft. What the wire carries is
 * unchanged: a message with the chip is the message Chat has always sent in Chopin's mode (an
 * `@chopin` put in front of it by `prepareDraftSubmission`), and a typed `@chopin` still addresses
 * Chopin as it always has.
 */

import { addressedOutsideReferences, reconcileReferenceDrafts } from "./references";

import type { MentionTrigger } from "./mentions";
import type { ChatSendPayload, ComposerDraft, ReferenceDraft } from "./references";

/** The chip's own accessible name, and its remove button's. */
export const ASKING_CHOPIN = "Asking Chopin";
export const REMOVE_CHOPIN = "Remove Chopin";

/** Whether a message is for Chopin, which a document without an agent never is. */
export function asksChopin(
	{ agent, chip, references, submitted, text }: {
		agent: boolean;
		chip: boolean;
		text: string;
		references: ReadonlyArray<Pick<ReferenceDraft, "start" | "end" | "kind">>;
		/** Where a send already prepared from this draft is going. */
		submitted?: ChatSendPayload["to"];
	},
): boolean {
	return agent
		&& (chip || submitted === "planner" || addressedOutsideReferences(text, [...references]));
}

/**
 * The chip a draft comes back with after a reload: on for a send prepared for Chopin whose words
 * did not name it, which is the chip's message, and off for one that named Chopin itself.
 */
export function restoredChip(draft: ComposerDraft, submitted?: ChatSendPayload["to"]): boolean {
	return submitted === "planner" && !addressedOutsideReferences(draft.text, draft.references);
}

type KeyEvent = {
	key: string;
	keyCode?: number;
	isComposing?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
};

/**
 * What a key does to the chip. Backspace with the caret at the very start of the draft takes it
 * off; Command+J or Control+J puts it on from anywhere and leaves it alone once it is on. Anything
 * else is the draft's own.
 */
export function chipKeyAction(
	event: KeyEvent,
	{ chip, selectionEnd, selectionStart }: {
		chip: boolean;
		selectionStart: number;
		selectionEnd: number;
	},
): "insert" | "remove" | undefined {
	if (event.isComposing || event.keyCode === 229) return undefined;
	if (event.key === "Backspace") {
		return chip && selectionStart === 0 && selectionEnd === 0 ? "remove" : undefined;
	}
	if (
		event.key.toLowerCase() === "j" && (event.metaKey || event.ctrlKey)
		&& !event.shiftKey && !event.altKey
	) return "insert";
	return undefined;
}

/**
 * Choosing Chopin in the `@` menu: the typed `@query` goes, and the chip says who the message is
 * for. A space the mention was set apart by goes with it, so no doubled or leading one is left.
 */
export function takeChopinMention(
	text: string,
	references: ReferenceDraft[],
	trigger: MentionTrigger,
): { text: string; references: ReferenceDraft[]; caret: number } {
	if (text.slice(trigger.start, trigger.end) !== `@${trigger.query}`) {
		return { text, references, caret: trigger.end };
	}
	let end = trigger.end;
	if (text[end] === " " && (trigger.start === 0 || text[trigger.start - 1] === " ")) end += 1;
	let next = text.slice(0, trigger.start) + text.slice(end);
	return {
		text: next,
		references: reconcileReferenceDrafts(text, next, references, {
			start: trigger.start,
			end,
		}),
		caret: trigger.start,
	};
}

/** What the empty draft says: the way to Chopin until the chip says it. */
export function draftPlaceholder({ agent, chip }: { agent: boolean; chip: boolean }): string {
	if (!agent) return "Message the team";
	return chip ? "Ask Chopin…" : "Message the team, or @Chopin to ask";
}
