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

/**
 * Whether the chip is drawn. It is the state (on once it is put on), and it is also shown for a
 * message that names Chopin in its words and for a send already prepared for Chopin, which are
 * for Chopin as much as the chip is. A command has an address of its own, so the chip gives way
 * to it.
 */
export function chipShown(
	{ agent, chip, references, submitted, text }: {
		agent: boolean;
		chip: boolean;
		text: string;
		references: ReadonlyArray<Pick<ReferenceDraft, "start" | "end" | "kind">>;
		submitted?: ChatSendPayload["to"];
	},
): boolean {
	if (!agent || references.some(reference => reference.kind === "command")) return false;
	return chip || submitted === "planner" || addressedOutsideReferences(text, [...references]);
}

/**
 * Taking the chip off a draft that names Chopin in its words takes those words out too, or the
 * message would still ask Chopin and the chip would come straight back. Each `@chopin` outside a
 * reference goes, with the one space it leaned on, and the references and the selection follow.
 */
export function withoutChopinMentions(
	text: string,
	references: ReferenceDraft[],
	selection: { start: number; end: number },
): { text: string; references: ReferenceDraft[]; start: number; end: number } {
	let removals = [...text.matchAll(/(^|[^\w@])@chopin\b/gi)]
		.map(match => {
			let start = match.index + match[1]!.length;
			let end = match.index + match[0].length;
			// Take one following space too where the mention began the text or followed one, so removing
			// it leaves no doubled or leading space.
			if (text[end] === " " && (start === 0 || text[start - 1] === " ")) end += 1;
			return { start, end };
		})
		.filter(edit =>
			!references.some(reference => edit.start < reference.end && edit.end > reference.start)
		);
	let next = text;
	let kept = references;
	let { start, end } = selection;
	for (let edit of removals.toReversed()) {
		let revised = next.slice(0, edit.start) + next.slice(edit.end);
		kept = reconcileReferenceDrafts(next, revised, kept, edit);
		if (edit.start < start) start -= Math.min(edit.end - edit.start, start - edit.start);
		if (edit.start < end) end -= Math.min(edit.end - edit.start, end - edit.start);
		next = revised;
	}
	return { text: next, references: kept, start, end };
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
