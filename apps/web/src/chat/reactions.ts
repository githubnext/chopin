import { displayName } from "@chopin/editor";

import type { Chat } from "@chopin/protocol";

export const QUICK_REACTIONS = [
	{ emoji: "✅", label: "Looks right" },
	{ emoji: "❓", label: "Explain this" },
	{ emoji: "👎", label: "Not quite" },
] as const;

export function reactedBy(reaction: Chat.Reaction, handle: string): boolean {
	return reaction.handles.includes(handle);
}

export function ownEmoji(
	reactions: readonly Chat.Reaction[] | undefined,
	handle: string,
): Set<string> {
	return new Set(
		(reactions ?? []).filter(reaction => reactedBy(reaction, handle)).map(reaction =>
			reaction.emoji
		),
	);
}

export function reactionHint(reaction: Chat.Reaction, self: string): string {
	let names = reaction.handles.map(handle => handle === self ? "You" : displayName(handle));
	let who = names.length < 2
		? names[0] ?? ""
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
	return `${who} reacted with ${reaction.emoji}`;
}

export function withReactions(
	entries: readonly Chat.Entry[],
	id: string,
	reactions: readonly Chat.Reaction[],
): Chat.Entry[] {
	return entries.map(entry =>
		entry.id === id
			? { ...entry, reactions: reactions.length > 0 ? [...reactions] : undefined }
			: entry
	);
}

/** How many reacted with each emoji, as a message last showed them. */
export type ReactionCounts = ReadonlyMap<string, number>;

export function reactionCounts(reactions: readonly Chat.Reaction[]): ReactionCounts {
	return new Map(reactions.map(reaction => [reaction.emoji, reaction.handles.length]));
}

/**
 * Which pills are new and which counts changed since a message last showed its reactions, so only
 * those move. With nothing shown before (the message has just been drawn, history included) nothing
 * has changed.
 */
export function reactionChanges(
	before: ReactionCounts | undefined,
	reactions: readonly Chat.Reaction[],
): { entered: Set<string>; counted: Set<string> } {
	let entered = new Set<string>();
	let counted = new Set<string>();
	if (!before) return { entered, counted };
	for (let reaction of reactions) {
		let count = before.get(reaction.emoji);
		if (count === undefined) entered.add(reaction.emoji);
		else if (count !== reaction.handles.length) counted.add(reaction.emoji);
	}
	return { entered, counted };
}
