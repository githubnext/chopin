import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { pendingInlineResearch } from "./research-placement.test-fixtures";
import { ulid } from "@chopin/dialect";
import { socket, submitResearchUpdate } from "./projection-submit.test-fixtures";
import { insertResearchProjection } from "./research-projection.test-fixtures";
import { linkedResearchJob, setResearchJobState } from "./research-projection-jobs.test-fixtures";

describe("hosted plan persistence", () => {
	it("accepts a browser-placed Research reference for a request with active work", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		// ResearchWorkspaceService mints UUID request ids, not ULIDs.
		let request = await pendingInlineResearch(context, context.channel.id, crypto.randomUUID());
		await linkedResearchJob(context, request.workspace.id, "evidence");
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		try {
			let update = await insertResearchProjection(peer, request.workspace.id);
			let replies = await submitResearchUpdate(context, plan, update, "uuid-research-insert");

			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(true);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(false);
			expect(Service.source(plan)).toContain(`<Research id="${request.workspace.id}" />`);
		} finally {
			peer.doc.destroy();
			await Service.close(plan);
		}
	});

	it("rejects a Research projection for an inline request with no linked work", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let originalSource = Service.source(plan);
		let request = await pendingInlineResearch(context);
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			originalSource,
			[],
		);
		try {
			let update = await insertResearchProjection(peer, request.workspace.id);
			let replies = await submitResearchUpdate(
				context,
				plan,
				update,
				"unlinked-research-projection",
			);

			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
			expect(Service.source(plan)).toBe(originalSource);
			let stored = await context.storage.research.get(context.channel.id, request.workspace.id);
			expect(stored?.workspace.origin).toBe("inline");
			expect(stored?.turns[0]?.kind).toBe("initial");
			expect(stored?.turns[0]?.evidenceJobId).toBeUndefined();
			expect(stored?.turns[0]?.answerJobId).toBeUndefined();
		} finally {
			peer.doc.destroy();
			await Service.close(plan);
		}
	});

	it("rejects a Research projection backed by a request from another channel", async () => {
		let context = await hosted();
		let otherChannel = await context.storage.channels.create({
			id: ulid(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other document",
			createdBy: "U_octocat",
			now: context.now,
		});
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let originalSource = Service.source(plan);
		let request = await pendingInlineResearch(context, otherChannel.id);
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			originalSource,
			[],
		);
		try {
			let update = await insertResearchProjection(peer, request.workspace.id);
			let replies: Array<Record<string, unknown>> = [];
			Service.submit(plan, socket(context, replies), {
				kind: "plan:update",
				ts: 0,
				rid: "foreign-research-projection",
				id: "foreign-research-projection",
				epoch: plan.document.epoch,
				update: Buffer.from(update).toString("base64"),
			});
			await Bun.sleep(20);
			await plan.flushing;

			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
			expect(Service.source(plan)).toBe(originalSource);
			expect(await context.storage.research.get(context.channel.id, request.workspace.id))
				.toBeUndefined();
		} finally {
			peer.doc.destroy();
			await Service.close(plan);
		}
	});

	it("rejects inserting a stale Research reference after its linked request failed", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let originalSource = Service.source(plan);
		let request = await pendingInlineResearch(context);
		let job = await linkedResearchJob(context, request.workspace.id, "evidence");
		await setResearchJobState(context, job.id, "failed");
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			originalSource,
			[],
		);
		try {
			let update = await insertResearchProjection(peer, request.workspace.id);
			let replies = await submitResearchUpdate(context, plan, update, "stale-research-insert");

			expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
			expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
			expect(Service.source(plan)).toBe(originalSource);
		} finally {
			peer.doc.destroy();
			await Service.close(plan);
		}
	});
});
