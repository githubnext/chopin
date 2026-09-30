import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import * as Questions from "./service";

import type { Socket } from "../wire";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
export async function subject(source = "# Title\n\nFirst.\n\nDecision prose.\n") {
	let document = await room.create(source);
	let anchor = room.anchorAt(document, 2, room.digests(document)[2]!);
	return { document, anchor };
}

export async function cardWithProse(source = "# Title\n\nDecision prose.\n", index = 1) {
	let context = await openPlan(source);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		context.channel.id,
		{
			threadId: "thread-a",
			header: "Authentication",
			question: "Which authentication approach?",
			options: [{ id: "01K0N4W3B7P27CBAEC7A8C8WEA", label: "GitHub Apps" }],
		},
	);
	let anchor = room.anchorAt(
		context.plan.document,
		index,
		room.digests(context.plan.document)[index]!,
	);
	Questions.setProse(context.plan, id, [anchor]);
	await Service.persist(context.plan);
	return { ...context, id, anchor };
}

export function peerFrames() {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test", canEdit: true },
		send(raw: string) {
			frames.push(JSON.parse(raw) as Record<string, unknown>);
		},
		publish() {},
		close() {},
	} as unknown as Socket;
	return { ws, frames };
}
