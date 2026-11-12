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
