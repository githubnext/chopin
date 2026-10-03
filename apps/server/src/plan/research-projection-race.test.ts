import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { pendingInlineResearch } from "./research-placement.test-fixtures";
import { socket } from "./projection-submit.test-fixtures";
import { insertResearchProjection } from "./research-projection.test-fixtures";
import { linkedResearchJob, setResearchJobState } from "./research-projection-jobs.test-fixtures";

describe("hosted plan persistence", () => {
	it("resets a Research insertion when its job fails after validation", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let originalSource = Service.source(plan);
		let request = await pendingInlineResearch(context);
		let job = await linkedResearchJob(context, request.workspace.id, "evidence");
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			originalSource,
			[],
		);
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let originalCommit = context.storage.collaboration.commit;
		context.storage.collaboration.commit = input => {
			if (!input.researchProjections?.length) return originalCommit(input);
			entered.resolve();
			return release.promise.then(() => originalCommit(input));
		};
		try {
			let update = await insertResearchProjection(peer, request.workspace.id);
			let replies: Array<Record<string, unknown>> = [];
			Service.submit(plan, socket(context, replies), {
				kind: "plan:update",
				ts: 0,
				rid: "racing-research-insert",
				id: "racing-research-insert",
				epoch: plan.document.epoch,
				update: Buffer.from(update).toString("base64"),
			});
			await Promise.race([
				entered.promise,
				Bun.sleep(1_000).then(() => {
					throw new Error("Research commit did not start");
				}),
			]);
			await setResearchJobState(context, job.id, "failed");
			release.resolve();
			await plan.flushing;

			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:update")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
			expect(Service.source(plan)).toBe(originalSource);
			let saved = await context.storage.collaboration.load(context.channel.id, context.now);
			expect(saved?.snapshot?.source).toBe(originalSource);
			expect(saved?.updates).toHaveLength(0);
		} finally {
			release.resolve();
			context.storage.collaboration.commit = originalCommit;
			peer.doc.destroy();
			await Service.close(plan);
		}
	});
});
