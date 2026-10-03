import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Service from "./service";
import { storedRunning } from "./planner-jobs.test-fixtures";

test("failed interruption commit rejects open and the next open retries it", async () => {
	let context = await storedRunning();
	let original = context.storage.collaboration.commit;
	let fail = true;
	let fatals: unknown[] = [];
	context.backend.fatal = error => fatals.push(error);
	context.storage.collaboration.commit = async input => {
		if (fail) {
			fail = false;
			throw new Error("storage unavailable");
		}
		return original(input);
	};
	await expect(Service.open(context.channel.id, context.backend, context.server))
		.rejects.toThrow("storage unavailable");
	let afterFailure = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let saved = afterFailure.sidecar ?? afterFailure.snapshot!.sidecar;
	expect(
		(saved as { conversationPlanJobs: ConversationPlan.Job[] })
			.conversationPlanJobs[0]?.status,
	).toBe("running");
	expect(fatals).toHaveLength(1);
	let opened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(opened.conversationPlanJobs[0]).toMatchObject({
			status: "failed",
			reason: "interrupted",
		});
		let afterRetry = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let retried = afterRetry.sidecar ?? afterRetry.snapshot!.sidecar;
		expect(
			(retried as { conversationPlanJobs: ConversationPlan.Job[] })
				.conversationPlanJobs[0]?.status,
		).toBe("failed");
	} finally {
		await Service.close(opened);
	}
});

test("a second reopen does not recommit an already interrupted job", async () => {
	let context = await storedRunning();
	let first = await Service.open(context.channel.id, context.backend, context.server);
	await Service.close(first);
	let committed = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let original = context.storage.collaboration.commit;
	let commits = 0;
	context.storage.collaboration.commit = async input => {
		commits++;
		return original(input);
	};
	let second = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(second.conversationPlanJobs[0]).toMatchObject({
			status: "failed",
			reason: "interrupted",
		});
		expect(commits).toBe(0);
		let after = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		expect(after.channel.revision).toBe(committed.channel.revision);
	} finally {
		await Service.close(second);
	}
});
