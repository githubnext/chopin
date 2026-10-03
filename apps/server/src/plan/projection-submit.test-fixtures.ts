import { ulid } from "@chopin/dialect";
import { $createTextNode, $getRoot, $isParagraphNode } from "lexical";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import type { Socket } from "../wire";

export function socket(
	context: Awaited<ReturnType<typeof hosted>>,
	frames: Array<Record<string, unknown>>,
) {
	return {
		data: { room: context.channel.id, handle: "octocat", client: "client", canEdit: true },
		send(value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
		publish(_topic: string, value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
		close() {},
	} as unknown as Socket;
}

export async function submitUpdate(
	context: Awaited<ReturnType<typeof hosted>>,
	plan: Service.Plan,
	peer: Room.Document,
	update: Uint8Array,
	frames: Array<Record<string, unknown>>,
): Promise<void> {
	Service.submit(plan, socket(context, frames), {
		kind: "plan:update",
		ts: 0,
		rid: ulid(),
		id: ulid(),
		epoch: plan.document.epoch,
		update: Buffer.from(update).toString("base64"),
	});
	await Bun.sleep(20);
	await plan.flushing;
	peer.doc.destroy();
}

export async function seededPlan(context: Awaited<ReturnType<typeof hosted>>) {
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	let peer = await Room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		Service.source(plan),
		[],
	);
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		let paragraph = $getRoot().getFirstChild();
		if (!$isParagraphNode(paragraph)) throw new Error("seed paragraph is missing");
		paragraph.append($createTextNode("Neighbor prose."));
	}, { discrete: true });
	await Room.settle();
	await submitUpdate(
		context,
		plan,
		peer,
		Y.encodeStateAsUpdate(peer.doc, before),
		[],
	);
	return plan;
}

export async function submitResearchUpdate(
	context: Awaited<ReturnType<typeof hosted>>,
	plan: Service.Plan,
	update: Uint8Array,
	rid: string,
) {
	let replies: Array<Record<string, unknown>> = [];
	Service.submit(plan, socket(context, replies), {
		kind: "plan:update",
		ts: 0,
		rid,
		id: rid,
		epoch: plan.document.epoch,
		update: Buffer.from(update).toString("base64"),
	});
	await Bun.sleep(20);
	await plan.flushing;
	return replies;
}
