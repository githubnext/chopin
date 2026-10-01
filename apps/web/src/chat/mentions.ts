import { MENTION } from "@chopin/protocol/address";

import { referencePickerKeyAction } from "./reference-picker";

import type { Chat } from "@chopin/protocol";
import type { ReferencePickerKeyAction } from "./reference-picker";

/** GitHub logins are at most 39 characters; a longer query cannot name anyone. */
export const MAX_MENTION_QUERY = 39;

const PLANNER_LOGIN = MENTION.slice(1);

export type MentionTrigger = {
	query: string;
	start: number;
	end: number;
};

export type MentionCandidate = {
	kind: "planner" | "person";
	login: string;
};

export type MentionInsertion = {
	text: string;
	caret: number;
};

/**
 * Find the unfinished `@login` immediately before the caret.
 *
 * The `@` must follow the same boundary `addressed()` requires — start of text
 * or a character that is neither a word character nor another `@` — so
 * `a@b.com` is an address, not a mention. A caret inside a word does not open
 * the list: selecting there would leave the rest of the word behind.
 */
export function mentionTrigger(
	text: string,
	selectionStart: number,
	selectionEnd = selectionStart,
): MentionTrigger | undefined {
	if (
		!Number.isSafeInteger(selectionStart)
		|| !Number.isSafeInteger(selectionEnd)
		|| selectionStart !== selectionEnd
		|| selectionStart < 0
		|| selectionStart > text.length
	) return undefined;
	if (/[\w-]/.test(text[selectionStart] ?? "")) return undefined;

	let at = selectionStart;
	while (at > 0 && /[A-Za-z0-9-]/.test(text[at - 1]!)) at--;
	if (at === 0 || text[at - 1] !== "@") return undefined;
	let start = at - 1;
	if (start > 0 && /[\w@]/.test(text[start - 1]!)) return undefined;
	let query = text.slice(at, selectionStart);
	if (query.length > MAX_MENTION_QUERY) return undefined;
	return { query, start, end: selectionStart };
}

export function mentionTriggerKey(trigger: MentionTrigger): string {
	return `mention:${trigger.start}:${trigger.end}:${trigger.query}`;
}

/** Most recent speaker first, so someone just talking with the composer's author is near the top. */
export function chatAuthors(entries: readonly Pick<Chat.Entry, "author">[]): string[] {
	let authors: string[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		let author = entries[index]!.author;
		if (author.kind === "member") authors.push(author.handle);
	}
	return authors;
}

/**
 * The Planner, then people here, then people who have spoken in this Chat.
 *
 * Logins are GitHub identities, so duplicates are case-insensitive. The
 * Planner's name is reserved: a person who happens to hold it would be
 * unreachable, because `@chopin` always addresses the Planner.
 */
export function mentionCandidates(
	{ authors, people, planner, self }: {
		authors: readonly string[];
		people: readonly string[];
		planner: boolean;
		self: string;
	},
): MentionCandidate[] {
	let seen = new Set([self.toLowerCase(), PLANNER_LOGIN]);
	let candidates: MentionCandidate[] = planner ? [{ kind: "planner", login: PLANNER_LOGIN }] : [];
	for (let login of [...people, ...authors]) {
		let identity = login.toLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		candidates.push({ kind: "person", login });
	}
	return candidates;
}

export function filterMentions(
	candidates: readonly MentionCandidate[],
	query: string,
): MentionCandidate[] {
	let prefix = query.toLowerCase();
	return candidates.filter(candidate => candidate.login.toLowerCase().startsWith(prefix));
}

/** Replace the typed `@query` with `@login ` and put the caret after the space. */
export function insertMention(
	text: string,
	trigger: MentionTrigger,
	candidate: MentionCandidate,
): MentionInsertion {
	if (text.slice(trigger.start, trigger.end) !== `@${trigger.query}`) {
		return { text, caret: trigger.end };
	}
	let token = `@${candidate.login}`;
	let spaced = text[trigger.end] === " ";
	let next = text.slice(0, trigger.start) + token + (spaced ? "" : " ") + text.slice(trigger.end);
	return { text: next, caret: trigger.start + token.length + 1 };
}

/** Tab also selects, as it does for `@` lists elsewhere; the `#` picker leaves Tab alone. */
export function mentionKeyAction(
	event: {
		key: string;
		keyCode?: number;
		isComposing?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
		ctrlKey?: boolean;
		metaKey?: boolean;
	},
	selectable: boolean,
): ReferencePickerKeyAction | undefined {
	if (
		event.key === "Tab"
		&& selectable
		&& !event.isComposing
		&& event.keyCode !== 229
		&& !event.shiftKey
		&& !event.altKey
		&& !event.ctrlKey
		&& !event.metaKey
	) return "select";
	return referencePickerKeyAction(event, selectable);
}
