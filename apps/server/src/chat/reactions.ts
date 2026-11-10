import type { Chat as Wire, Request } from "@chopin/protocol";

import { broadcast, fail, PASSING, reply } from "../wire";
import type { Socket } from "../wire";
import { MAX_MESSAGE_BYTES } from "./limits";
import type { Room } from "./service";

/**
 * The one resource bound: everything the reactions to a message hold (each emoji and each handle)
 * may take as many bytes as the message itself may, `MAX_MESSAGE_BYTES`. No emoji is refused for
 * its form or its length on its own; a sequence of any length is kept as sent.
 */
export const MAX_REACTION_BYTES = MAX_MESSAGE_BYTES;

export function reactionBytes(reactions: readonly Wire.Reaction[]): number {
	return reactions.reduce(
		(total, reaction) =>
			total + Buffer.byteLength(reaction.emoji)
			+ reaction.handles.reduce((sum, handle) => sum + Buffer.byteLength(handle), 0),
		0,
	);
}

/** The reactions after one person's emoji is added or taken back, in the order first used. */
export function toggle(
	reactions: readonly Wire.Reaction[] | undefined,
	handle: string,
	emoji: string,
	on: boolean,
): { reactions: Wire.Reaction[]; changed: boolean } {
	let current = reactions ?? [];
	let existing = current.find(reaction => reaction.emoji === emoji);
	let has = !!existing?.handles.includes(handle);
	if (has === on) return { reactions: current.slice(), changed: false };
	if (on) {
		return {
			changed: true,
			reactions: existing
				? current.map(reaction =>
					reaction === existing ? { emoji, handles: [...reaction.handles, handle] } : reaction
				)
				: [...current, { emoji, handles: [handle] }],
		};
	}
	return {
		changed: true,
		reactions: current.flatMap(reaction => {
			if (reaction !== existing) return [reaction];
			let handles = reaction.handles.filter(value => value !== handle);
			return handles.length ? [{ emoji, handles }] : [];
		}),
	};
}

/** Whether a message may carry reactions: a person's or the Planner's, never a system notice. */
export function reactable(entry: Wire.Entry | undefined): entry is Wire.Entry {
	return !!entry && entry.author.kind !== "system";
}

const INTENTS = new Set(["confused", "disagree", "approve", "ack", "more"]);

/** Saved reactions are read back strictly: a malformed list is a malformed transcript. */
export function validateReactions(entry: Wire.Entry): void {
	let kept = entry as Wire.Entry & { viaReaction?: unknown; answeredIntents?: unknown };
	if (
		Object.hasOwn(entry, "viaReaction")
			&& (kept.viaReaction !== true || entry.author.kind !== "agent")
		|| Object.hasOwn(entry, "answeredIntents")
			&& (entry.author.kind !== "agent" || !Array.isArray(kept.answeredIntents)
				|| kept.answeredIntents.length > INTENTS.size
				|| kept.answeredIntents.some((intent: unknown) =>
					typeof intent !== "string" || !INTENTS.has(intent)
				)
				|| new Set(kept.answeredIntents).size !== kept.answeredIntents.length)
	) throw new Error("hosted channel has invalid chat reactions");
	if (!Object.hasOwn(entry, "reactions")) return;
	let reactions = entry.reactions as unknown;
	let emojis = new Set<string>();
	if (
		!reactable(entry) || !Array.isArray(reactions) || reactions.length === 0
	) throw new Error("hosted channel has invalid chat reactions");
	for (let item of reactions as unknown[]) {
		let reaction = item as Wire.Reaction | null;
		let keys = reaction && typeof reaction === "object" && !Array.isArray(reaction)
			? Object.keys(reaction).sort()
			: [];
		if (
			keys.length !== 2 || keys[0] !== "emoji" || keys[1] !== "handles"
			|| typeof reaction!.emoji !== "string" || !reaction!.emoji
			|| emojis.has(reaction!.emoji)
			|| !Array.isArray(reaction!.handles) || reaction!.handles.length === 0
			|| reaction!.handles.some(handle => typeof handle !== "string" || !handle)
			|| new Set(reaction!.handles).size !== reaction!.handles.length
		) throw new Error("hosted channel has invalid chat reactions");
		emojis.add(reaction!.emoji);
	}
	if (reactionBytes(reactions as Wire.Reaction[]) > MAX_REACTION_BYTES) {
		throw new Error("hosted channel has invalid chat reactions");
	}
}

/** What a change of reactions tells whatever may answer it; called only once it is saved. */
export type Reacted = {
	entry: Wire.Entry;
	emoji: string;
	handle: string;
	on: boolean;
	ws: Socket;
};

/**
 * Add or take back the sender's reaction to a message.
 *
 * Taken after every send already admitted, so a reaction never overtakes the message it is to,
 * and saved before anyone hears of it. The caller has already checked that the sender may read
 * the document.
 */
export function react(
	context: Room,
	ws: Socket,
	msg: Request<Wire.React>,
	changed?: (reacted: Reacted) => void,
): Promise<void> {
	let process = () =>
		reactNow(context, ws, msg, changed).catch(err => {
			console.error(
				"[chat] a reaction could not be saved:",
				err instanceof Error ? err.name : "unknown",
			);
			fail(ws, msg.rid, "could not save reaction", PASSING);
		});
	let accepted = context.chat.sending.then(process, process);
	context.chat.sending = accepted.then(() => {}, () => {});
	return accepted;
}

async function reactNow(
	context: Room,
	ws: Socket,
	msg: Request<Wire.React>,
	changed?: (reacted: Reacted) => void,
): Promise<void> {
	let { chat, room, server } = context;
	if (
		typeof msg.id !== "string" || typeof msg.emoji !== "string" || typeof msg.on !== "boolean"
		|| !msg.emoji
	) return fail(ws, msg.rid, "invalid reaction");
	let entry = chat.entries.find(value => value.id === msg.id);
	if (!reactable(entry)) {
		return fail(ws, msg.rid, "this message cannot take reactions");
	}
	let handle = ws.data.handle;
	let next = toggle(entry.reactions, handle, msg.emoji, msg.on);
	let answer = { kind: "chat:react", ts: 0, id: msg.id, emoji: msg.emoji, on: msg.on } as const;
	if (!next.changed) return reply(ws, msg.rid, answer);
	if (msg.on && reactionBytes(next.reactions) > MAX_REACTION_BYTES) {
		return fail(ws, msg.rid, "this message has as many reactions as it can take");
	}
	// The saved transcript carries the new list before the live one does.
	await context.persist(() => ({
		entries: chat.entries.map(value =>
			value === entry
				? (next.reactions.length
					? { ...value, reactions: next.reactions }
					: (({ reactions: _reactions, ...rest }) => rest)(value))
				: value
		),
		runs: chat.runs,
		initiativePaused: chat.initiativePaused,
	}));
	if (next.reactions.length) entry.reactions = next.reactions;
	else delete entry.reactions;
	reply(ws, msg.rid, answer);
	broadcast(server, room, {
		kind: "chat:reactions",
		ts: 0,
		id: msg.id,
		reactions: next.reactions,
	});
	changed?.({ entry, emoji: msg.emoji, handle, on: msg.on, ws });
}
