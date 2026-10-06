import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { JobRegistry } from "../jobs/registry";
import { JobRunner } from "../jobs/runner";
import { JobService } from "../jobs/service";
import { researchBriefDefinition, sourceId } from "../jobs/research-brief";
import type { Room } from "../rooms";
import { researchDraftHarness } from "./research-draft.test-fixtures";
import { createConversationRuntime } from "./runtime";
import { unlinked } from "./service.test-fixtures";

test("runner failure publishes a durable failed offer and explicit retry publishes the rewritten brief", async () => {
	let h = await openPlan();
	let seed = researchDraftHarness();
	h.plan.chat.entries = seed.plan.chat.entries;
	h.plan.conversationPlan = seed.plan.conversationPlan;
	await Plan.persist(h.plan);
	let room: Room = { id: h.plan.id, plan: h.plan, members: new Map() };
	let errors: unknown[] = [];
	let succeed = false;
	let registry = new JobRegistry([researchBriefDefinition({
		config: { agent: true, model: "fixture" },
		engine: async execution => {
			if (!succeed) throw new Error("synthetic worker startup failure");
			return {
				brief: "Investigate alternatives to Jev for conversation classification.",
				sourceIds: [sourceId(execution.input.sources[0]!)],
				model: "fixture",
			};
		},
	})]);
	let runner: JobRunner;
	let runtime: ReturnType<typeof createConversationRuntime>;
	let changed = async (channelId: string) => {
		if (channelId === room.id) runtime.refreshBriefs(h.plan);
	};
	let jobs = new JobService({
		storage: h.storage,
		registry,
		lease: () => h.lease,
		onChange: job => runner.notify(job),
		publish: changed,
	});
	runtime = createConversationRuntime({
		config: {
			agent: true,
			conversationPlan: true,
			conversationPlanModel: "fixture",
			conversationPlanTimeoutMs: 100,
		},
		server: () => h.server,
		unavailable: () => false,
		researchJobs: () => jobs,
		interpret: async () => unlinked(),
		onError: error => errors.push(error),
	});
	runner = new JobRunner({
		storage: h.storage,
		service: jobs,
		registry,
		lease: () => h.lease,
		enabled: true,
		globalConcurrency: 1,
		ownerConcurrency: 1,
		pollMs: 5,
		retryBaseMs: 5,
		retryMaxMs: 10,
		claimTtlMs: 1000,
		heartbeatMs: 100,
		shutdownGraceMs: 50,
		resolveActivePlanner: async () => ({
			credential: {
				kind: "active-planner",
				token: "fixture-only",
				ownerSessionId: "owner",
				ownerGeneration: 1,
				credentialRevision: 1,
				expiresAt: new Date(Date.now() + 60_000),
				authorize: async () => true,
			},
			ownerKey: "owner",
			binding: undefined,
			active: async () => true,
			release() {},
		}),
		changed,
		fatal: error => errors.push(error),
	});
	let wait = async (state: "failed" | "ready") => {
		let deadline = Date.now() + 3000;
		while (h.plan.conversationPlan.researchOffers![0]!.workflow!.preparation !== state) {
			if (Date.now() >= deadline) throw new Error(`Offer never became ${state}`);
			await Bun.sleep(5);
		}
	};
	try {
		await runtime.attach(room, h.plan, false, true);
		runner.start();
		await wait("failed");
		let failed = structuredClone(h.plan.conversationPlan.researchOffers![0]!);
		let job = await jobs.get(h.plan.id, failed.workflow!.jobId!);
		expect(job?.job).toMatchObject({ state: "failed", attempts: 2 });
		let saved = await h.storage.collaboration.load(h.plan.id, new Date());
		expect(saved!.sidecar ?? saved!.snapshot!.sidecar).toMatchObject({
			conversationPlan: { researchOffers: [{ workflow: { preparation: "failed" } }] },
		});
		expect(
			h.broadcasts.some(frame =>
				frame.kind === "conversation-plan:changed"
				&& (frame.state as ConversationPlan.State).researchOffers?.[0]?.workflow?.preparation
					=== "failed"
			),
		).toBe(true);
		succeed = true;
		await runtime.processor(h.plan)!.editResearch(failed.id, { kind: "retry" }, seed.actor);
		await wait("ready");
		let ready = h.plan.conversationPlan.researchOffers![0]!;
		expect(ready.id).toBe(failed.id);
		expect(ready.source).toEqual(failed.source);
		expect(ready.workflow!.jobId).not.toBe(failed.workflow!.jobId);
		expect(ready.brief).toBe("Investigate alternatives to Jev for conversation classification.");
		expect(errors).toEqual([]);
	} finally {
		await runner.shutdown();
		await runtime.stop(h.plan);
		await Plan.close(h.plan);
		await h.storage.close();
	}
});
