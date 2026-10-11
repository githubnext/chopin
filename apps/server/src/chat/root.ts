/**
 * How a child document reaches its root's Chat.
 *
 * A child has no Chat of its own. A comment sent to Chopin inside one runs on
 * the root's Chat, with the child as the turn's focus, and the turn answers in
 * the child's thread. Every call opens the root's room and re-asks storage that
 * the child still belongs to it, so a child that was archived or moved, or a
 * root that went away, refuses rather than reaching the wrong document.
 */
import { resolveChild } from "./children";
import * as Chat from "./service";

import type { ChannelStore } from "../storage/port";

export type RootChatDeps = {
	rootId: string;
	childId: string;
	repositoryId: string;
	channels: Pick<ChannelStore, "get">;
	/** Opens the root's room and its Chat; `release` lets the room go again. */
	open: () => Promise<{ context: Chat.Room; release: () => void }>;
	/** The root's Chat if its room is open, without opening it. */
	live: () => Chat.Chat | undefined;
};

export function createRootChat(deps: RootChatDeps): Chat.RootChat {
	let opened = async () => {
		let child = await resolveChild(deps.channels, deps.rootId, deps.repositoryId, deps.childId);
		if (!child) throw new Error("this document no longer belongs to its root document");
		let { context, release } = await deps.open();
		return { child, context, release };
	};
	return {
		id: deps.rootId,
		async admission(thread) {
			let { context, release } = await opened();
			try {
				return Chat.admission(context, thread, deps.childId);
			} finally {
				release();
			}
		},
		async instruct(handle, text, said, about) {
			let { child, context, release } = await opened();
			// Held until this instruction's own turn has ended, however it ends. A folded or
			// refused instruction has no turn of its own, so nothing would ever say so.
			let begun = false;
			let settled = false;
			let done = () => {
				if (settled) return;
				settled = true;
				release();
			};
			let ended: Chat.Instruction["ended"] = async outcome => {
				try {
					await about.ended?.(outcome);
				} finally {
					done();
				}
			};
			let backstop = () => {
				if (!settled) void ended({ status: "stopped" });
			};
			try {
				await Chat.instruct(context, handle, text, said, {
					...about,
					started: () => {
						begun = true;
						about.started?.();
						// A Chat closed mid-turn never reports the turn's end, so the
						// running promise, assigned once this returns, stands in for it.
						queueMicrotask(() => {
							void context.chat.running?.finally(backstop).catch(() => {});
						});
					},
					ended,
					threadChannel: child.id,
					focus: { channelId: child.id, title: child.title },
					...(about.comment ? { comment: { ...about.comment, channelId: child.id } } : {}),
				});
			} catch (err) {
				done();
				throw err;
			}
			if (!begun && !context.chat.waiting.some(item => item.ended === ended)) done();
		},
		working: thread => Chat.workingFor(deps.live(), thread, deps.childId),
	};
}
