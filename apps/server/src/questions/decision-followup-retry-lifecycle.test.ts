import { expect, test } from "bun:test";
import { applyAnchors, applyBlockEdit } from "../agent/document-ops";
import { createPlannerJobs } from "../conversation-plan/planner-jobs";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { meta } from "./card-notifications";
import { fixture, restart, scopeRoom } from "./decision-followup.test-fixtures";
import { scopeSnapshot } from "./decision-followup";
import { writeScope } from "./decision-followup-write";

test("failed write, foreground rewrite, explicit re-anchor and Retry commit actual prose once", async () => {
	let context = await fixture();
	let id = context.ids[0]!;
	await context.save(id, "Keep offline support and the existing API.");
	let room = scopeRoom(context);
	room.publish = mutation =>
		Service.publish(context.plan, context.server, context.plan.id, mutation);
	let attempts = 0;
	let repaired = false;
	room.visualAdmission = async () =>
		repaired ? [] : [{
			code: "E_VISUAL_REQUIRED",
			path: "sources[0]",
			message: "Include the supported offline comparison.",
		}];
	let jobs = createPlannerJobs({
		plan: context.plan,
		exclusive: room.exclusive,
		persist: () => Service.persistExclusive(context.plan),
		prompt: () => "Use the saved decision and current explicit passage.",
		runner: async job => {
			attempts++;
			context.plan.chat.job = job;
			try {
				let snapshot = scopeSnapshot(context.plan, id);
				let written = await writeScope(room, job, context.plan.chat.turn, {
					id,
					revision: snapshot.revision,
					answersHash: snapshot.answersHash,
					source: "Offline support is required.\n\nThe existing API stays stable.",
				});
				return { status: "done", output: JSON.stringify(written.output) };
			} finally {
				context.plan.chat.job = undefined;
			}
		},
		publishJobs() {},
		publishMeta() {},
		activity: () => Service.persistExclusive(context.plan),
	});
	try {
		let effect = context.plan.conversationPlanPendingEffects.find(effect =>
			effect.kind === "job" && effect.intent.kind === "decision-followup"
		)!;
		if (effect.kind !== "job") throw new Error("expected the saved-decision outbox effect");
		await jobs.enqueue(effect.intent, effect.key);
		await jobs.idle();
		let failed = jobs.jobs()[0]!;
		expect(failed.status).toBe("failed");
		expect(meta(context.plan, context.plan.records.get(id)!)).toMatchObject({
			hasProse: false,
			writeup: { status: "failed", job: failed.id },
		});
		expect(context.plan.records.get(id)!.followUp!.appliedGeneration).toBeUndefined();
		await room.exclusive(() =>
			applyBlockEdit(room, {
				revision: context.plan.revision,
				operations: [{
					op: "replace",
					index: 0,
					source: "Offline support is required while travelling.\n\nThe existing API stays stable.",
				}],
			})
		);
		let digests = Room.digests(context.plan.document);
		expect(
			await applyAnchors(room, {
				revision: context.plan.revision,
				anchors: [{
					widget: id,
					question: context.plan.records.get(id)!.definition.questions[0]!.id,
					blocks: [0, 1].map(index => ({ index, digest: digests[index]! })),
				}],
			}),
		).toMatchObject({ ok: true });
		jobs.wake();
		await jobs.idle();
		expect(attempts).toBe(1);
		expect(meta(context.plan, context.plan.records.get(id)!).writeup?.status).toBe("failed");
		repaired = true;
		expect(await jobs.retry(failed.id)).toBe(true);
		await jobs.idle();
		expect(attempts).toBe(2);
		expect(jobs.jobs()[0]).toMatchObject({ id: failed.id, status: "done", attempts: 2 });
		let restored = await restart(context);
		expect(scopeSnapshot(restored.plan, id).source)
			.toBe("Offline support is required.\n\nThe existing API stays stable.\n");
		expect(Room.project(restored.plan.document)).toContain("Keep this unrelated paragraph.");
		expect(restored.plan.records.get(id)!.followUp!.appliedGeneration).toBe(1);
		expect(meta(restored.plan, restored.plan.records.get(id)!)).toMatchObject({
			hasProse: true,
			proseOrphaned: false,
		});
		expect(meta(restored.plan, restored.plan.records.get(id)!).writeup).toBeUndefined();
	} finally {
		jobs.stop();
	}
});
