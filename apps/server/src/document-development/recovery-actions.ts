import * as Y from "yjs";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Comments from "../comments/service";
import { ordinaryRecovery } from "./recovery";

export function recoveryConflicts(
	plan: Pick<Service.Plan, "documentDevelopment">,
): Array<{ id: string; digest: string; source: string }> {
	return plan.documentDevelopment?.recovery?.retired.flatMap(item =>
		item.version?.status === "pending"
			? [{ id: item.id, digest: item.version.digest, source: item.version.source }]
			: []
	) ?? [];
}

/** Exact-version resolution: another arriving edit must never be dismissed or added accidentally. */
export async function resolveRecovery(
	plan: Service.Plan,
	id: string,
	digest: string,
	action: "add" | "dismiss",
	eligible: () => boolean = () => true,
): Promise<"applied" | "stale" | "blocked"> {
	await Service.drain(plan);
	return Service.exclusive(plan, async () => {
		if (!eligible() || Service.implementationActive(plan)) return "blocked";
		let state = plan.documentDevelopment;
		let item = state?.recovery?.retired.find(item => item.id === id);
		if (!item?.version || item.version.digest !== digest || item.version.status !== "pending") {
			return "stale";
		}
		if (action === "add" && !ordinaryRecovery(item.version.source)) return "blocked";
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		let candidate: Service.Plan = {
			...plan,
			document,
			records: new Map(plan.records),
			threads: new Map(plan.threads),
			outlines: new Map(plan.outlines),
			documentDevelopment: structuredClone(state),
		};
		try {
			Questions.rebase(candidate);
			Comments.rebase(candidate);
			let result = action === "add"
				? edit.apply(candidate, candidate.revision, [{
					op: "insert_root",
					source: item.version.source,
				}])
				: undefined;
			if (result && !result.ok) return "blocked";
			candidate.documentDevelopment!.recovery!.retired.find(item => item.id === id)!.version!
				.status = action === "add" ? "added" : "dismissed";
			if (!eligible()) return "blocked";
			await Service.publishStaged(
				plan,
				plan.server,
				plan.id,
				candidate,
				result?.ok ? result.mutation : undefined,
			);
			return "applied";
		} finally {
			document.doc.destroy();
		}
	});
}
