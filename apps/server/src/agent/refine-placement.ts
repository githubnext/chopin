import * as Y from "yjs";
import * as Comments from "../comments/service";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import type { Context } from "./card-tool-context";
import type { Address } from "./refine-fields";

export async function placeCard(
	context: Context,
	id: string,
	at: Address,
	beforePublish: () => void,
): Promise<boolean> {
	let { plan } = context;
	let source = room.project(plan.document);
	let candidate: Service.Plan = {
		...plan,
		records: new Map(plan.records),
		threads: new Map(plan.threads),
		outlines: new Map(plan.outlines),
	};
	Questions.rebase(candidate);
	Comments.rebase(candidate);
	let stagedDocument = await room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		source,
		[],
	);
	stagedDocument.seq = plan.document.seq;
	candidate.document = stagedDocument;
	try {
		let mutation = Questions.place(candidate, [{ widget: id, blocks: [at] }]);
		if (!mutation) return false;
		beforePublish();
		await Service.publishStaged(plan, context.server, context.room, candidate, mutation, {
			agent: true,
		});
		context.anchors();
		return true;
	} finally {
		stagedDocument.doc.destroy();
	}
}
