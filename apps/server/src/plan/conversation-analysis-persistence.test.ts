import { expect, test } from "bun:test";
import * as Service from "./service";
import { openPlan } from "../testing/plan";
import { enqueue } from "../conversation-plan/domain";

async function damage(
	context: Awaited<ReturnType<typeof openPlan>>,
	mutate: (sidecar: Record<string, unknown>) => void,
) {
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	mutate(sidecar);
	await context.storage.collaboration.commit({
		channelId: context.channel.id,
		lease: context.lease,
		expectedRevision: loaded.channel.revision,
		operationId: crypto.randomUUID(),
		epoch: loaded.snapshot!.epoch,
		sidecar: sidecar as never,
		events: [],
		now: context.now,
	});
}

test("conversation analysis and explicit retry identity survive a real sidecar commit", async () => {
	let context = await openPlan();
	let state = enqueue(context.plan.conversationPlan, "message-1");
	context.plan.chat.entries.push({
		id: "message-1",
		author: { kind: "member", handle: "ana" },
		text: "An outline?",
		ts: 1,
	});
	context.plan.conversationPlan = state;
	context.plan.conversationPlanRetries = [{ id: "retry-1", messageId: "message-1" }];
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(restored.conversationPlan).toEqual(state);
		expect(restored.conversationPlanRetries).toEqual([{ id: "retry-1", messageId: "message-1" }]);
		expect(restored.document.seq).toBe(0);
		expect(restored.revision).toBe(0);
	} finally {
		await Service.close(restored);
	}
});

test("retry restoration rejects malformed, duplicate and absent source identities", async () => {
	let cases = [
		{ value: [{ id: "retry", messageId: "missing" }], error: "without a source message" },
		{
			value: [{ id: "retry", messageId: "m1", extra: true }],
			error: "invalid conversation analysis retry",
		},
		{
			value: [{ id: "retry", messageId: "m1" }, { id: "retry", messageId: "m1" }],
			error: "invalid conversation analysis retry",
		},
		{
			value: [{ id: "x".repeat(251), messageId: "m1" }],
			error: "invalid conversation analysis retry",
		},
	];
	for (let item of cases) {
		let context = await openPlan();
		await Service.close(context.plan);
		await damage(context, sidecar => {
			sidecar.conversationPlanRetries = item.value;
			sidecar.transcript = [{
				id: "m1",
				author: { kind: "member", handle: "ana" },
				text: "Hi",
				ts: 1,
			}];
		});
		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow(item.error);
	}
});

test("failed conversation persistence leaves durable state unchanged and can be retried", async () => {
	let context = await openPlan();
	let original = context.storage.collaboration.commit;
	let fatals: unknown[] = [];
	context.backend.fatal = error => fatals.push(error);
	context.plan.persistence.fatal = context.backend.fatal;
	let fail = true;
	context.storage.collaboration.commit = async input => {
		if (fail) {
			fail = false;
			throw new Error("storage unavailable");
		}
		return original(input);
	};
	context.plan.chat.entries.push({
		id: "m1",
		author: { kind: "member", handle: "ana" },
		text: "An outline?",
		ts: 1,
	});
	context.plan.conversationPlan = enqueue(context.plan.conversationPlan, "m1");
	await expect(Service.persist(context.plan)).rejects.toThrow("storage unavailable");
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = loaded.sidecar ?? loaded.snapshot!.sidecar;
	expect((sidecar as { transcript: unknown[] }).transcript).toEqual([]);
	expect(fatals).toHaveLength(1);
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	try {
		expect(restored.conversationPlan.queue).toEqual([{
			messageId: "m1",
			status: "pending",
			attempts: 0,
		}]);
	} finally {
		await Service.close(restored);
	}
});
