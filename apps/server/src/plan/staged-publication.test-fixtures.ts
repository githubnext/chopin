import * as Y from "yjs";
import * as edit from "./edit";
import * as room from "./room";
import type { Plan } from "./service";

export async function staged(plan: Plan, source: string) {
	let document = await room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		room.project(plan.document),
		[],
	);
	document.seq = plan.document.seq;
	let candidate = {
		...plan,
		document,
		records: new Map(plan.records),
		threads: new Map(plan.threads),
		outlines: new Map(plan.outlines),
		conversationPlanEffects: [...plan.conversationPlanEffects, "heading:document:m1"],
	};
	let result = edit.replace(candidate, plan.revision, source);
	if (!result.ok || !result.mutation) throw new Error("test edit must change the document");
	return { candidate, mutation: result.mutation };
}
