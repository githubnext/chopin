import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "./service";
import { hosted } from "./conversation-persistence.test-fixtures";

describe("durable conversation outboxes", () => {
	it("restores the effect outbox and rejects malformed present entries", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let pending = {
			key: "job:heading:document",
			kind: "job" as const,
			intent: { kind: "heading" as const, target: "document", trigger: "m1" },
		};
		await Service.exclusive(plan, async () => {
			plan.conversationPlanEffects = ["insert:old-thread"];
			plan.conversationPlanPendingEffects = [pending];
			await Service.persistExclusive(plan);
		});
		await Service.close(plan);
		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.conversationPlanEffects).toEqual(["insert:old-thread"]);
		expect(restored.conversationPlanPendingEffects).toEqual([pending]);
		await Service.close(restored);

		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
			string,
			unknown
		>;
		sidecar.conversationPlanPendingEffects = [{ ...pending, unexpected: true }];
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: loaded.channel.revision,
			operationId: "invalid-effect-outbox",
			epoch: loaded.snapshot!.epoch,
			sidecar: sidecar as never,
			events: [],
			now: context.now,
		});
		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("conversation effects");
	});

	it("restores pending card actions and rejects malformed present entries", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let cardId = ulid();
		let action = {
			id: `card:${cardId}:reopened:1`,
			cardId,
			threadId: "thread-a",
			actor: "ana",
			at: 9,
			kind: "reopened" as const,
			generation: 1,
		};
		await Service.exclusive(plan, async () => {
			plan.pendingCardActions = [action];
			await Service.persistExclusive(plan);
		});
		await Service.close(plan);
		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.pendingCardActions).toEqual([action]);
		await Service.close(restored);

		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
			string,
			unknown
		>;
		sidecar.pendingCardActions = [{ ...action, generation: 0 }];
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: loaded.channel.revision,
			operationId: "invalid-card-action-outbox",
			epoch: loaded.snapshot!.epoch,
			sidecar: sidecar as never,
			events: [],
			now: context.now,
		});
		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("card actions");
	});

	it("rejects pending analysis whose source message is absent", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let epoch = plan.document.epoch;
		await Service.close(plan);
		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
			string,
			unknown
		>;
		let analysis = sidecar.conversationPlan as Record<string, unknown>;
		analysis.queue = [{ messageId: "missing", status: "pending", attempts: 0 }];
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: loaded.channel.revision,
			operationId: "orphan-analysis",
			epoch,
			sidecar: sidecar as never,
			events: [],
			now: context.now,
		});
		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("without a source message");
	});
});
