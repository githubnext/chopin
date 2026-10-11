/**
 * Where an MCP `invoke_planner` instruction runs.
 *
 * A root document's instruction runs on its own Chat. A child has no Chat, so
 * its instruction runs on its root's, with the child as the turn's focus. The
 * child's parentage and repository are asked of storage again first; a child
 * that no longer belongs to a live root in the caller's repository is refused.
 */
import { resolveChild } from "../chat/children";
import * as Chat from "../chat/service";

import type { InvokePlannerError } from "../mcp";
import type { ChannelStore } from "../storage/port";
import type { PlannerInvocation } from "./hosted";

export type InvocationRoute = {
	channels: Pick<ChannelStore, "get">;
	deleting: (channelId: string) => boolean;
	/** Serializes the work with the root's archive, restore and delete. */
	transition: <T>(channelId: string, action: () => Promise<T>) => Promise<T>;
	/** Opens the root's room and its Chat for this caller; `release` lets the room go. */
	open: (
		rootId: string,
		input: PlannerInvocation,
	) => Promise<{ context: Chat.Room; release: () => void }>;
};

export async function invokeRouted(
	route: InvocationRoute,
	input: PlannerInvocation,
): Promise<InvokePlannerError | undefined> {
	let target = await route.channels.get(input.channel.id);
	if (!target || route.deleting(target.id)) return "document-unavailable";
	let rootId = target.parentChannelId ?? target.id;
	// A child call holds the root's transition; child tools recheck under the child's own.
	return route.transition(rootId, async () => {
		let root = await route.channels.get(rootId);
		if (!root || route.deleting(rootId)) return "document-unavailable";
		if (root.archivedAt || target.archivedAt) return "document-archived";
		let focus: Chat.Instruction["focus"];
		if (target.parentChannelId) {
			let child = await resolveChild(route.channels, rootId, input.repository.id, target.id);
			if (!child) return "document-unavailable";
			focus = { channelId: child.id, title: child.title };
		}
		let { context, release } = await route.open(rootId, input);
		let code: InvokePlannerError | undefined;
		try {
			// Released once the invoked turn itself ends, even when it waits behind others.
			code = await Chat.invoke(
				context,
				input.user,
				input.instruction,
				input.checkout,
				focus,
				release,
			);
		} catch (err) {
			release();
			throw err;
		}
		if (code) release();
		return code;
	});
}
