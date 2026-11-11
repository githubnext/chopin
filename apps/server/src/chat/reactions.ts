import type { Chat as Wire, Request } from "@chopin/protocol";

import { broadcast, fail, PASSING, reply } from "../wire";
import type { Socket } from "../wire";
import type { Room } from "./service";

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

const EMOJI_BYTES = 64;
const REACTIONS_PER_PERSON = 20;
let graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Whether `emoji` is one extended grapheme cluster of at most 64 UTF-8 bytes. The longest emoji
 * Unicode lists, a kiss with two skin tones, is 35, so every emoji the picker offers fits.
 */
export function oneEmoji(emoji: string): boolean {
	if (Buffer.byteLength(emoji) > EMOJI_BYTES) return false;
	let count = 0;
	for (let _ of graphemes.segment(emoji)) if (++count > 1) return false;
	return count === 1;
}

export function reactable(entry: Wire.Entry | undefined): entry is Wire.Entry {
	return !!entry && entry.author.kind !== "system";
}

const INTENTS = new Set(["confused", "disagree", "approve", "ack", "more"]);

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
}

export type Reacted = {
	entry: Wire.Entry;
	emoji: string;
	handle: string;
	on: boolean;
	ws: Socket;
};

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
		|| msg.seq !== undefined && !(Number.isSafeInteger(msg.seq) && msg.seq >= 0)
	) return fail(ws, msg.rid, "invalid reaction");
	if (!oneEmoji(msg.emoji)) return fail(ws, msg.rid, "a reaction is a single emoji");
	let entry = chat.entries.find(value => value.id === msg.id);
	if (!reactable(entry)) {
		return fail(ws, msg.rid, "this message cannot take reactions");
	}
	let handle = ws.data.handle;
	if (msg.on) {
		let own = (entry.reactions ?? []).filter(reaction => reaction.handles.includes(handle));
		if (
			own.length >= REACTIONS_PER_PERSON && !own.some(reaction => reaction.emoji === msg.emoji)
		) {
			return fail(
				ws,
				msg.rid,
				`you can react to a message with at most ${REACTIONS_PER_PERSON} different emoji`,
			);
		}
	}
	let next = toggle(entry.reactions, handle, msg.emoji, msg.on);
	let numbered = msg.seq === undefined ? {} : { seq: msg.seq };
	let answer = {
		kind: "chat:react",
		ts: 0,
		id: msg.id,
		emoji: msg.emoji,
		on: msg.on,
		...numbered,
	} as const;
	if (!next.changed) return reply(ws, msg.rid, answer);
	// Persistence before publication: the saved transcript carries the new list before the live one.
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
		...(msg.seq === undefined ? {} : {
			by: handle,
			emoji: msg.emoji,
			seq: msg.seq,
			...(typeof msg.tab === "string" ? { tab: msg.tab } : {}),
		}),
	});
	changed?.({ entry, emoji: msg.emoji, handle, on: msg.on, ws });
}
