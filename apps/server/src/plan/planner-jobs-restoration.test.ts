import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Service from "./service";
import { openPlan } from "../testing/plan";
import { storedRunning } from "./planner-jobs.test-fixtures";

test("a missing Planner job field restores as empty and stays optional", async () => {
	let context = await openPlan();
	try {
		expect(context.plan.conversationPlanJobs).toEqual([]);
		await Service.persist(context.plan);
		let saved = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = saved.sidecar ?? saved.snapshot!.sidecar;
		expect(Object.hasOwn(sidecar as object, "conversationPlanJobs")).toBe(false);
	} finally {
		await Service.close(context.plan);
	}
});

test("observational stored reads leave a running Planner job untouched", async () => {
	let context = await storedRunning();
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let original = context.storage.collaboration.commit;
	let commits = 0;
	context.storage.collaboration.commit = async input => {
		commits++;
		return original(input);
	};
	await Service.readStored(loaded);
	expect(commits).toBe(0);
	let after = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = after.sidecar ?? after.snapshot!.sidecar;
	expect(
		(sidecar as { conversationPlanJobs: ConversationPlan.Job[] })
			.conversationPlanJobs[0]?.status,
	).toBe("running");
});

test("one malformed Planner job rejects the entire saved sidecar", async () => {
	let context = await openPlan();
	await Service.close(context.plan);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	sidecar.conversationPlanJobs = [{ id: "bad" }];
	await context.storage.collaboration.commit({
		channelId: context.channel.id,
		lease: context.lease,
		expectedRevision: loaded.channel.revision,
		operationId: "bad-planner-job",
		epoch: loaded.snapshot!.epoch,
		sidecar: sidecar as never,
		events: [],
		now: context.now,
	});
	await expect(Service.open(context.channel.id, context.backend, context.server))
		.rejects.toThrow("invalid Planner job");
});

test("archived documents durably interrupt running jobs during maintenance open", async () => {
	let context = await storedRunning();
	await context.storage.channels.archive({ id: context.channel.id, now: context.now });
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(opened.conversationPlanJobs[0]).toMatchObject({
			status: "failed",
			reason: "interrupted",
		});
		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = loaded.sidecar ?? loaded.snapshot!.sidecar;
		expect(
			(sidecar as { conversationPlanJobs: ConversationPlan.Job[] })
				.conversationPlanJobs[0]?.status,
		).toBe("failed");
	} finally {
		await Service.close(opened);
	}
});
