import { afterEach, describe, expect, it } from "bun:test";

import { JobRegistry } from "../jobs/registry";
import { JobService } from "../jobs/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { RecommendationCoordinator } from "./coordinator";
import { recommendationContext } from "./context";
import { parseRecommendationArtifact, parseRecommendationInput } from "./schema";

import type { JobDefinition } from "../jobs/registry";
import type { RecommendationArtifact, RecommendationInput } from "./schema";

const TARGET = "build-recommendation:document";
let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (let close of cleanup.splice(0)) await close();
});

function input(source = "Expose the existing decision creation action."): RecommendationInput {
	return recommendationContext({ source, sidecar: { revision: 1 } })!;
}

function artifact(context: RecommendationInput): RecommendationArtifact {
	return {
		key: context.key,
		planRevision: context.planRevision,
		model: "fixture",
		recommendation: {
			kind: "build",
			title: "Expose decision creation",
			scope: "Add the existing action to the Decisions tab.",
			reasons: ["The action already exists."],
			dependencies: [],
			optional: ["Broader onboarding can stay open."],
			evidenceIds: [context.evidence[0]!.id],
			nextAction: "Discuss the Decisions tab entry point.",
		},
	};
}

async function fixture() {
	let storage = new MemoryStorage();
	let channelId = crypto.randomUUID();
	let userId = crypto.randomUUID();
	let now = new Date();
	await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
	await storage.channels.create({
		id: channelId,
		repositoryId: "repository",
		repositoryOwner: "githubnext",
		repositoryName: "chopin",
		title: "Useful next build",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("Fixture lease unavailable");
	let definition: JobDefinition<RecommendationInput, RecommendationArtifact> = {
		type: "build-recommendation",
		version: 1,
		label: "Next build",
		description: "Advisory fixture",
		origins: ["scheduler"],
		credential: "active-planner",
		limits: {
			timeoutMs: 1000,
			maxAttempts: 1,
			maxAiCredits: 1,
			maxInputBytes: 128 * 1024,
			maxArtifactBytes: 32 * 1024,
		},
		input: { parse: parseRecommendationInput },
		artifact: { parse: parseRecommendationArtifact },
		execute: async execution => artifact(execution.input),
	};
	let service = new JobService({
		storage,
		registry: new JobRegistry([definition]),
		lease: () => lease,
	});
	let current: RecommendationInput | undefined = input();
	let eligible = true;
	let timers = new Set<() => void>();
	let changes: string[] = [];
	let errors: unknown[] = [];
	let coordinators: RecommendationCoordinator[] = [];
	let create = (
		overrides: Partial<ConstructorParameters<typeof RecommendationCoordinator>[0]> = {},
	) => {
		let coordinator = new RecommendationCoordinator({
			service,
			jobs: storage.jobs,
			current: async () => current,
			eligible: async () => eligible,
			changed: id => changes.push(id),
			error: error => errors.push(error),
			after: (_delay, action) => {
				timers.add(action);
				return () => {
					timers.delete(action);
				};
			},
			...overrides,
		});
		coordinators.push(coordinator);
		return coordinator;
	};
	let coordinator = create();
	cleanup.push(async () => {
		for (let instance of coordinators) instance.close();
		await Promise.all(coordinators.map(instance => instance.idle()));
		await storage.close();
	});
	return {
		storage,
		service,
		lease,
		channelId,
		coordinator,
		timers,
		changes,
		errors,
		create,
		change: (value: RecommendationInput | undefined) => current = value,
		owner: (value: boolean) => eligible = value,
		async flush(instance = coordinator) {
			await instance.idle();
			let actions = [...timers];
			timers.clear();
			for (let action of actions) action();
			await instance.idle();
			expect(errors).toEqual([]);
		},
		async list() {
			return (await storage.jobs.list(channelId, 50))!.jobs;
		},
		async claim() {
			let [job] = await storage.jobs.claim({
				channelId,
				claimOwner: "fixture",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease,
			});
			if (!job) throw new Error("Fixture job unavailable");
			return job;
		},
	};
}

async function complete(f: Awaited<ReturnType<typeof fixture>>, value?: RecommendationArtifact) {
	let job = await f.claim();
	return f.service.settle({
		channelId: f.channelId,
		jobId: job.id,
		claimOwner: "fixture",
		claimGeneration: job.claimGeneration,
		artifact: value ?? artifact(parseRecommendationInput(job.input)),
	});
}

describe("recommendation scheduling and durable reads", () => {
	it("a completed quiet assessment survives restart without re-enqueueing unchanged context", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		await complete(f, { ...artifact(input()), recommendation: null });
		let reader = f.create();
		expect(await reader.read(f.channelId)).toEqual({ state: "quiet", key: input().key });
		reader.schedule(f.channelId);
		await f.flush(reader);
		expect(await f.list()).toHaveLength(1);
		let changed = input("We are ready to explore the decision status now.");
		f.change(changed);
		expect(await reader.read(f.channelId)).toEqual({ state: "pending", key: changed.key });
	});

	it("coalesces repeated schedules and does not re-enqueue unchanged persisted context", async () => {
		let f = await fixture();
		for (let count = 0; count < 8; count++) f.coordinator.schedule(f.channelId);
		await f.coordinator.idle();
		expect(f.timers.size).toBe(1);
		expect(f.changes).toEqual([f.channelId]);
		await f.flush();
		expect(await f.list()).toHaveLength(1);
		f.coordinator.schedule(f.channelId);
		await f.flush();
		expect(await f.list()).toHaveLength(1);
	});

	it("a direction change supersedes pending work at the same durable target", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		let first = (await f.list())[0]!;
		let changed = input("Keep creation unchanged; label the open status.");
		f.change(changed);
		expect(await f.coordinator.read(f.channelId)).toEqual({ state: "pending", key: changed.key });
		f.coordinator.schedule(f.channelId);
		await f.flush();
		let detail = await f.storage.jobs.current(f.channelId, TARGET);
		expect(detail?.job.input).toEqual(changed);
		expect(detail?.target.generation).toBe(2);
		expect((await f.storage.jobs.get(f.channelId, first.id))?.job.state).toBe("superseded");
	});

	it("owner absence never enqueues or claims ownership, but later eligibility can schedule", async () => {
		let f = await fixture();
		f.owner(false);
		f.coordinator.schedule(f.channelId);
		await f.flush();
		expect(await f.list()).toHaveLength(0);
		expect(await f.coordinator.read(f.channelId)).toEqual({ state: "unavailable" });
		f.owner(true);
		f.coordinator.schedule(f.channelId);
		await f.flush();
		expect(await f.list()).toHaveLength(1);
	});

	it("a new coordinator recovers a completed artifact without starting new work", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		await complete(f);
		f.coordinator.close();
		let restarted = f.create();
		expect(await restarted.read(f.channelId)).toMatchObject({
			state: "ready",
			key: input().key,
			planRevision: 1,
			recommendation: { optional: ["Broader onboarding can stay open."] },
		});
		restarted.schedule(f.channelId);
		await f.flush(restarted);
		expect(await f.list()).toHaveLength(1);
	});

	it("failed and cancelled durable jobs remain terminal under reads and same-context schedules", async () => {
		for (let terminal of ["failed", "cancelled"] as const) {
			let f = await fixture();
			f.coordinator.schedule(f.channelId);
			await f.flush();
			let job = await f.claim();
			if (terminal === "failed") {
				await f.storage.jobs.fail({
					channelId: f.channelId,
					jobId: job.id,
					claimOwner: "fixture",
					claimGeneration: job.claimGeneration,
					reason: "worker-failed",
					now: new Date(),
					lease: f.lease,
				});
			} else await f.service.cancel({ channelId: f.channelId, jobId: job.id });
			expect(await f.coordinator.read(f.channelId)).toEqual({ state: "failed", key: input().key });
			f.coordinator.schedule(f.channelId);
			await f.flush();
			expect(await f.list()).toHaveLength(1);
			expect((await f.storage.jobs.get(f.channelId, job.id))?.job.state).toBe(terminal);
		}
	});

	it("missing jobs are pending and missing context is unavailable without observational scheduling", async () => {
		let f = await fixture();
		expect(await f.coordinator.read(f.channelId)).toEqual({ state: "pending", key: input().key });
		expect(f.timers.size).toBe(0);
		expect(await f.list()).toHaveLength(0);
		f.change(undefined);
		expect(await f.coordinator.read(f.channelId)).toEqual({ state: "unavailable" });
	});

	it("a context mutation during the durable job read never returns the previous artifact", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		await complete(f);
		let changed = input("Investigate read-only decision access before proposing a build.");
		let reader = f.create({
			jobs: {
				current: async (id, target) => {
					let detail = await f.storage.jobs.current(id, target);
					f.change(changed);
					return detail;
				},
			},
		});
		expect(await reader.read(f.channelId)).toEqual({ state: "pending", key: changed.key });
	});

	it("a target change during a read cannot resurrect an older artifact when context returns to A", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		await complete(f);
		let waiting = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let reads = 0;
		let reader = f.create({
			current: async () => {
				if (++reads === 2) {
					waiting.resolve();
					await release.promise;
				}
				return input();
			},
		});
		let pending = reader.read(f.channelId);
		await waiting.promise;
		for (let next of [input("Investigate a different direction."), input()]) {
			f.change(next);
			f.coordinator.schedule(f.channelId);
			await f.flush();
		}
		let latest = (await f.storage.jobs.current(f.channelId, TARGET))!;
		reader.jobChanged(latest.job);
		release.resolve();
		expect(await pending).toEqual({ state: "pending", key: input().key });
		expect(latest.job.state).toBe("pending");
	});

	it("a completed artifact from an obsolete target generation stays hidden", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		await complete(f);
		let reader = f.create({
			jobs: {
				current: async (id, target) => {
					let detail = await f.storage.jobs.current(id, target);
					return detail
						&& {
							...detail,
							target: { ...detail.target, generation: detail.target.generation + 1 },
						};
				},
			},
		});
		expect(await reader.read(f.channelId)).toEqual({ state: "pending", key: input().key });
	});

	it("forget and close cancel scheduled timers, and late callbacks cannot enqueue", async () => {
		let f = await fixture();
		f.coordinator.schedule(f.channelId);
		await f.coordinator.idle();
		let [stale] = f.timers;
		f.coordinator.forget(f.channelId);
		expect(f.timers.size).toBe(0);
		stale!();
		await f.coordinator.idle();
		expect(await f.list()).toHaveLength(0);
		f.coordinator.schedule(f.channelId);
		await f.coordinator.idle();
		[stale] = f.timers;
		f.coordinator.close();
		stale!();
		f.coordinator.schedule(f.channelId);
		await f.flush();
		expect(await f.list()).toHaveLength(0);
		expect(await f.coordinator.read(f.channelId)).toEqual({ state: "unavailable" });
	});

	it("close while context loading cancels the queued schedule", async () => {
		let f = await fixture();
		let started = Promise.withResolvers<void>();
		let result = Promise.withResolvers<RecommendationInput>();
		let coordinator = f.create({
			current: async () => {
				started.resolve();
				return result.promise;
			},
		});
		coordinator.schedule(f.channelId);
		await started.promise;
		coordinator.close();
		result.resolve(input());
		await coordinator.idle();
		expect(f.timers.size).toBe(0);
		expect(await f.list()).toHaveLength(0);
	});

	it("forget while context loading cancels the queued schedule", async () => {
		let f = await fixture();
		let started = Promise.withResolvers<void>();
		let result = Promise.withResolvers<RecommendationInput>();
		let coordinator = f.create({
			current: async () => {
				started.resolve();
				return result.promise;
			},
		});
		coordinator.schedule(f.channelId);
		await started.promise;
		coordinator.forget(f.channelId);
		result.resolve(input());
		await coordinator.idle();
		expect(f.timers.size).toBe(0);
		await f.flush(coordinator);
		expect(await f.list()).toHaveLength(0);
	});

	it("forget while eligibility loading prevents the pending enqueue", async () => {
		let f = await fixture();
		let started = Promise.withResolvers<void>();
		let allowed = Promise.withResolvers<boolean>();
		let coordinator = f.create({
			eligible: async () => {
				started.resolve();
				return allowed.promise;
			},
		});
		coordinator.schedule(f.channelId);
		let flushing = f.flush(coordinator);
		await started.promise;
		coordinator.forget(f.channelId);
		allowed.resolve(true);
		await flushing;
		expect(await f.list()).toHaveLength(0);
	});
});
