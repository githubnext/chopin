import { describe, expect, it } from "bun:test";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { pendingInlineResearch } from "./research-placement.test-fixtures";
import { submitResearchUpdate } from "./projection-submit.test-fixtures";
import {
	addResearchReference,
	removeResearchProjection,
} from "./research-projection.test-fixtures";
import {
	linkedResearchJob,
	publishReadyResearch,
	setResearchJobState,
} from "./research-projection-jobs.test-fixtures";

describe("hosted plan persistence", () => {
	it("rejects removing an inline Research reference while linked work is active", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let request = await pendingInlineResearch(context);
		let job = await linkedResearchJob(context, request.workspace.id, "evidence");
		let peer = await addResearchReference(
			context,
			plan,
			request.workspace.id,
			"active-research-add",
		);
		try {
			let update = await removeResearchProjection(peer, request.workspace.id);
			let replies = await submitResearchUpdate(context, plan, update, "active-research-remove");

			expect((await context.storage.jobs.get(context.channel.id, job.id))?.job.state)
				.toBe("pending");
			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
			expect(Service.source(plan)).toContain(`<Research id="${request.workspace.id}" />`);
		} finally {
			peer.doc.destroy();
			await Service.close(plan);
		}
	});

	for (let terminal of ["failed", "cancelled", "ready"] as const) {
		it(`allows removing an inline Research reference after ${terminal} work`, async () => {
			let context = await hosted();
			let plan = await Service.open(context.channel.id, context.backend, context.server);
			let request = await pendingInlineResearch(context);
			let evidence = await linkedResearchJob(context, request.workspace.id, "evidence");
			let peer = await addResearchReference(
				context,
				plan,
				request.workspace.id,
				`terminal-research-add-${terminal}`,
			);
			if (terminal === "failed" || terminal === "cancelled") {
				await setResearchJobState(context, evidence.id, terminal);
			} else if (terminal === "ready") {
				await setResearchJobState(context, evidence.id, "completed");
				await publishReadyResearch(context, request.workspace.id);
			}
			try {
				let update = await removeResearchProjection(peer, request.workspace.id);
				let replies = await submitResearchUpdate(
					context,
					plan,
					update,
					`terminal-research-remove-${terminal}`,
				);

				expect(replies.some(frame => frame.kind === "plan:ack")).toBe(true);
				expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(false);
				expect(Service.source(plan)).not.toContain(`<Research id="${request.workspace.id}" />`);
			} finally {
				peer.doc.destroy();
				await Service.close(plan);
			}
		});
	}
});
