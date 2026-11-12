import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { WireRefusal } from "../../wire";
import { noteEmojiUse } from "../actions/emoji-frequent";
import { passing, refusalText } from "../delivery";
import { dueNow, intentsReducer } from "../pending-reactions";

import type { Chat } from "@chopin/protocol";
import type { Wire } from "../../wire";

/**
 * Reactions made in a thread's panel, to its root or a reply: shown at once, sent with the thread's
 * root so that the Planner answers them in the thread, and settled by what the room is told, as
 * Chat's own are (`pending-reactions.ts`). The panel keeps its own, under its own tab.
 */
export function useThreadReactions(
	wire: Wire | undefined,
	rootId: string,
	ready: boolean,
	handle: string,
	entries: readonly Chat.Entry[],
) {
	let [intents, dispatch] = useReducer(intentsReducer, []);
	let [tab] = useState(() => crypto.randomUUID());
	let latest = useRef(entries);
	latest.current = entries;
	let saved = useMemo(() => new Set(entries.map(entry => entry.id)), [entries]);

	useEffect(() => {
		if (!wire) return;
		let settle = (frame: Chat.Reactions) =>
			dispatch({
				kind: "settle",
				id: frame.id,
				reactions: frame.reactions,
				handle,
				tab,
				...(frame.by !== undefined && frame.emoji !== undefined
					? { applied: { by: frame.by, emoji: frame.emoji, seq: frame.seq, tab: frame.tab } }
					: {}),
			});
		let off = [
			wire.on<Chat.InThread>("chat:in-thread", frame => {
				if (frame.rootId === rootId && frame.frame.kind === "chat:reactions") settle(frame.frame);
			}),
			// The root is Chat's message, and its reactions are told as Chat's.
			wire.on<Chat.Reactions>("chat:reactions", frame => {
				if (frame.id === rootId) settle(frame);
			}),
		];
		return () => {
			for (let unsubscribe of off) unsubscribe();
		};
	}, [wire, rootId, handle, tab]);

	// A connection that comes back has lost the answers to what was sent on the last one: what the
	// thread does not hold yet is sent again.
	useEffect(() => {
		if (ready) dispatch({ kind: "history", entries: latest.current, handle });
	}, [ready, wire, handle]);

	useEffect(() => {
		if (!wire || !ready) return;
		for (let { id, emoji, on, seq } of dueNow(intents, saved)) {
			dispatch({ kind: "sent", id, emoji, on, seq });
			void wire.ask<Chat.Reacted>("chat:react", { id, emoji, on, seq, tab, thread: rootId }).then(
				() => {
					dispatch({
						kind: "settle",
						id,
						answers: { emoji, on, seq },
						reactions: latest.current.find(entry => entry.id === id)?.reactions,
						handle,
						tab,
					});
					dispatch({ kind: "answered", id, emoji, on, seq });
				},
				error => {
					if (!(error instanceof WireRefusal)) return;
					if (passing(error.code)) dispatch({ kind: "drop", id, emoji, on, seq });
					else {
						dispatch({
							kind: "refuse",
							id,
							emoji,
							on,
							seq,
							text: refusalText(error.code, error.message),
						});
					}
				},
			);
		}
	}, [wire, ready, intents, saved, handle, tab, rootId]);

	useEffect(() => {
		if (ready && intents.length > 0) dispatch({ kind: "prune", present: saved });
	}, [ready, intents.length, saved]);

	let seq = useRef(0);
	let react = useCallback((id: string, emoji: string, on: boolean) => {
		if (on) noteEmojiUse(emoji);
		dispatch({ kind: "ask", id, emoji, on, seq: ++seq.current });
	}, []);
	return { intents, react };
}
