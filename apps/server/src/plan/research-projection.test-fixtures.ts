import { $createResearchNode, ResearchNode } from "@chopin/dialect";
import { $getRoot, $nodesOfType } from "lexical";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { submitResearchUpdate } from "./projection-submit.test-fixtures";

export async function insertResearchProjection(
	peer: Room.Document,
	id: string,
): Promise<Uint8Array> {
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => $getRoot().append($createResearchNode(id)), { discrete: true });
	await Room.settle();
	return Y.encodeStateAsUpdate(peer.doc, before);
}

export async function removeResearchProjection(
	peer: Room.Document,
	id: string,
): Promise<Uint8Array> {
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		let node = $nodesOfType(ResearchNode).find(candidate => candidate.getId() === id);
		if (!node) throw new Error("research projection is missing from peer");
		node.remove();
	}, { discrete: true });
	await Room.settle();
	return Y.encodeStateAsUpdate(peer.doc, before);
}

export async function addResearchReference(
	context: Awaited<ReturnType<typeof hosted>>,
	plan: Service.Plan,
	workspaceId: string,
	rid: string,
) {
	let peer = await Room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		Service.source(plan),
		[],
	);
	let update = await insertResearchProjection(peer, workspaceId);
	let replies = await submitResearchUpdate(context, plan, update, rid);
	if (!replies.some(frame => frame.kind === "plan:ack")) {
		peer.doc.destroy();
		throw new Error("pending research reference was not accepted");
	}
	return peer;
}
