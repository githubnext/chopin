import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import { socket } from "./projection-submit.test-fixtures";
import { changeProjection, protectedFixture } from "./protected-projection.test-fixtures";

describe("hosted plan persistence", () => {
	for (let kind of ["decision", "questionnaire"] as const) {
		for (let change of ["remove", "alter"] as const) {
			it(`rejects a browser ${change} of an accepted ${kind} projection before ack`, async () => {
				let { context, plan, id } = await protectedFixture(kind);
				let originalSource = Service.source(plan);
				let peer = await Room.restore(
					plan.document.epoch,
					Y.encodeStateAsUpdate(plan.document.doc),
					originalSource,
					[],
				);
				try {
					let update = await changeProjection(peer, kind, id, change);
					let replies: Array<Record<string, unknown>> = [];
					Service.submit(plan, socket(context, replies), {
						kind: "plan:update",
						ts: 0,
						rid: "protected-projection",
						id: "protected-projection",
						epoch: plan.document.epoch,
						update: Buffer.from(update).toString("base64"),
					});
					await Bun.sleep(20);
					await plan.flushing;

					expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
					expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
					expect(Service.source(plan)).toBe(originalSource);
					if (kind === "decision") {
						expect(plan.threads.get(id)?.status).toBe("accepted");
					} else {
						expect(plan.records.get(id)?.status).toBe("answered");
					}
				} finally {
					peer.doc.destroy();
					await Service.close(plan);
				}
			});
		}

		for (let change of ["remove-and-edit", "alter-and-edit"] as const) {
			it(`rejects a prose edit bundled with ${change} of an accepted ${kind}`, async () => {
				let { context, plan, id } = await protectedFixture(kind);
				let originalSource = Service.source(plan);
				let originalEpoch = plan.document.epoch;
				let peer = await Room.restore(
					originalEpoch,
					Y.encodeStateAsUpdate(plan.document.doc),
					originalSource,
					[],
				);
				let activePlan = plan;
				try {
					let update = await changeProjection(peer, kind, id, change);
					let replies: Array<Record<string, unknown>> = [];
					Service.submit(activePlan, socket(context, replies), {
						kind: "plan:update",
						ts: 0,
						rid: "combined-projection-edit",
						id: "combined-projection-edit",
						epoch: originalEpoch,
						update: Buffer.from(update).toString("base64"),
					});
					await Bun.sleep(20);
					await activePlan.flushing;

					expect(replies.some(frame => frame.kind === "plan:ack")).toBe(false);
					expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(true);
					expect(activePlan.document.epoch).not.toBe(originalEpoch);
					expect(Service.source(activePlan)).toBe(originalSource);
					expect(Service.source(activePlan)).not.toContain("Edited.");
					if (kind === "decision") {
						expect(activePlan.threads.get(id)?.status).toBe("accepted");
					} else {
						expect(activePlan.records.get(id)?.status).toBe("answered");
					}

					await Service.close(activePlan);
					activePlan = await Service.open(
						context.channel.id,
						context.backend,
						context.server,
					);
					expect(Service.source(activePlan)).toBe(originalSource);
					if (kind === "decision") {
						expect(activePlan.threads.get(id)?.status).toBe("accepted");
					} else {
						expect(activePlan.records.get(id)?.status).toBe("answered");
					}
				} finally {
					peer.doc.destroy();
					await Service.close(activePlan);
				}
			});
		}

		it(`accepts moving an exact ${kind} projection with adjacent prose edits`, async () => {
			let { context, plan, id } = await protectedFixture(kind);
			let originalSource = Service.source(plan);
			let peer = await Room.restore(
				plan.document.epoch,
				Y.encodeStateAsUpdate(plan.document.doc),
				originalSource,
				[],
			);
			try {
				let update = await changeProjection(peer, kind, id, "move-and-edit");
				let replies: Array<Record<string, unknown>> = [];
				Service.submit(plan, socket(context, replies), {
					kind: "plan:update",
					ts: 0,
					rid: "move-projection",
					id: "move-projection",
					epoch: plan.document.epoch,
					update: Buffer.from(update).toString("base64"),
				});
				await Bun.sleep(20);
				await plan.flushing;

				expect(replies.some(frame => frame.kind === "plan:ack")).toBe(true);
				expect(context.frames.some(frame => frame.kind === "plan:reset")).toBe(false);
				let source = Service.source(plan);
				expect(source).toContain("Edited.");
				expect(source).toContain(`id="${id}"`);
				expect(source.indexOf(kind === "decision" ? "<Decision" : "<Questionnaire"))
					.toBeLessThan(source.indexOf("Neighbor prose."));
				if (kind === "decision") {
					expect(plan.threads.get(id)?.status).toBe("accepted");
					expect(source).toContain('quote="Neighbor prose."');
				} else {
					expect(plan.records.get(id)?.status).toBe("answered");
					expect(source).toContain('status="decided"');
					expect(source).toContain('label="S3"');
				}
			} finally {
				peer.doc.destroy();
				await Service.close(plan);
			}
		});
	}
});
