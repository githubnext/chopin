import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Service from "./service";
import { AT, storedRunning } from "./planner-jobs.test-fixtures";

test("restart durably records an interrupted Planner job before opening", async () => {
	let context = await storedRunning([{
		id: "heading:document:m0",
		kind: "heading",
		target: "document",
		trigger: "m0",
		status: "done",
		attempts: 1,
		output: "{}",
		at: AT,
	}]);
	let before = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let beforeSidecar = (before.sidecar ?? before.snapshot!.sidecar) as {
		revision: number;
		documentSeq: number;
	};
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(opened.conversationPlanJobs.map(job => [job.status, job.reason])).toEqual([
			["failed", "interrupted"],
			["done", undefined],
		]);
		let after = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = after.sidecar ?? after.snapshot!.sidecar;
		expect((sidecar as { conversationPlanJobs: ConversationPlan.Job[] })
			.conversationPlanJobs.map(job => job.status)).toEqual(["failed", "done"]);
		expect((sidecar as { documentSeq: number }).documentSeq).toBe(beforeSidecar.documentSeq);
		expect((sidecar as { revision: number }).revision).toBe(beforeSidecar.revision);
		expect(opened.document.seq).toBe(beforeSidecar.documentSeq);
		expect(opened.revision).toBe(beforeSidecar.revision);
	} finally {
		await Service.close(opened);
	}
});

test("open waits for interrupted-job durability before exposing the plan", async () => {
	let context = await storedRunning();
	let original = context.storage.collaboration.commit;
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	context.storage.collaboration.commit = async input => {
		entered.resolve();
		await release.promise;
		return original(input);
	};
	let returned = false;
	let opening = Service.open(context.channel.id, context.backend, context.server).then(plan => {
		returned = true;
		return plan;
	});
	await entered.promise;
	let held = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let heldSidecar = held.sidecar ?? held.snapshot!.sidecar;
	let jobs = (heldSidecar as { conversationPlanJobs: ConversationPlan.Job[] }).conversationPlanJobs;
	expect(jobs[0]?.status).toBe("running");
	expect(returned).toBe(false);
	release.resolve();
	let opened = await opening;
	try {
		expect(opened.conversationPlanJobs[0]).toMatchObject({
			status: "failed",
			reason: "interrupted",
		});
	} finally {
		await Service.close(opened);
	}
});
