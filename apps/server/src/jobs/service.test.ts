import { describe, expect, it, spyOn } from "bun:test";

import { JobRegistry } from "./registry";
import { JobService } from "./service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { JobDefinition } from "./registry";
import type { JsonValue, Lease } from "../storage/model";

function definition(version = 1): JobDefinition {
	return {
		type: "test-report",
		version,
		label: "Test report",
		description: "Produces a bounded report for tests.",
		origins: ["scheduler", "user"],
		credential: "active-planner",
		limits: {
			timeoutMs: 10_000,
			maxAttempts: 2,
			maxAiCredits: 32,
			maxInputBytes: 128,
			maxArtifactBytes: 128,
		},
		input: {
			parse(value) {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
				let question = value.question;
				if (typeof question !== "string" || !question.trim()) throw new Error("question");
				return { question: question.trim() };
			},
		},
		artifact: {
			parse(value) {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
				let report = value.report;
				if (typeof report !== "string" || !report.trim()) throw new Error("report");
				return { report: report.trim() };
			},
		},
	};
}

async function context(): Promise<{
	storage: MemoryStorage;
	channelId: string;
	lease: Lease;
}> {
	let storage = new MemoryStorage();
	let now = new Date();
	let userId = crypto.randomUUID();
	let channelId = crypto.randomUUID();
	await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
	await storage.channels.create({
		id: channelId,
		repositoryId: crypto.randomUUID(),
		repositoryOwner: "githubnext",
		repositoryName: "chopin",
		title: "Background jobs",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("lease unavailable");
	return { storage, channelId, lease };
}

describe("background job registry", () => {
	it("keeps one immutable contract per version and selects the newest", () => {
		let first = definition(1);
		let second = definition(2);
		let registry = new JobRegistry([second, first]);

		expect(registry.current("test-report")?.version).toBe(2);
		expect(registry.get("test-report", 1)?.version).toBe(1);
		expect(registry.list().map(value => `${value.type}@${value.version}`))
			.toEqual(["test-report@2"]);
		expect(() => ((registry.current("test-report") as { version: number }).version = 99))
			.toThrow();
		expect(registry.current("test-report")?.version).toBe(2);
		expect(() => registry.register(first)).toThrow("already registered");
	});

	it("rejects malformed or unbounded definitions", () => {
		expect(() => new JobRegistry([{ ...definition(), type: "Bad Type" }])).toThrow("Invalid");
		expect(() =>
			new JobRegistry([{
				...definition(),
				limits: { ...definition().limits, maxAttempts: 0 },
			}])
		).toThrow("positive integer");
		expect(() => new JobRegistry([{ ...definition(), origins: ["user", "user"] }]))
			.toThrow("distinct");
	});
});

describe("background job service", () => {
	it("derives version and fingerprint before publishing durable enqueue", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let publications: string[] = [];
			let registry = new JobRegistry([definition(1), definition(2)]);
			registry.register({ ...definition(1), type: "other-report" });
			let sequence = 0;
			let service = new JobService({
				storage,
				registry,
				lease: () => lease,
				id: () => `job-${++sequence}`,
				publish: async published => {
					expect((await storage.jobs.list(published, 10))!.jobs).not.toHaveLength(0);
					publications.push(published);
				},
			});
			let request = {
				channelId,
				type: "test-report",
				targetKey: "research:question-1",
				idempotencyKey: "request-1",
				input: { question: "  What changed?  " },
			};
			let first = await service.enqueueUser(request);
			expect(first).toMatchObject({
				repeated: false,
				job: { id: "job-1", version: 2, origin: "user", state: "pending" },
			});
			expect(publications).toEqual([channelId]);
			let detail = await storage.jobs.get(channelId, first.job.id);
			expect(detail!.job.input).toEqual({ question: "What changed?" });
			expect(detail!.job.fingerprint).toMatch(/^[a-f0-9]{64}$/);

			let repeated = await service.enqueueUser(request);
			expect(repeated).toEqual({ ...first, repeated: true });
			expect(publications).toEqual([channelId]);
			let other = await service.enqueueUser({
				...request,
				type: "other-report",
				idempotencyKey: "request-2",
			});
			expect(other.job.targetKey).toBe("other-report:research:question-1");
			expect((await service.get(channelId, first.job.id))!.job.state).toBe("pending");
			await expect(service.enqueueUser({ ...request, input: { question: "Different" } }))
				.rejects.toMatchObject({ failure: "conflict" });
		} finally {
			await storage.close();
		}
	});

	it("rejects unknown origins, malformed input, and oversized values", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let service = new JobService({
				storage,
				registry: new JobRegistry([definition()]),
				lease: () => lease,
			});
			let request = {
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "request",
				input: { question: "Question" },
			};
			await expect(service.enqueuePlanner(request)).rejects.toMatchObject({
				code: "origin-forbidden",
			});
			await expect(service.enqueueUser({ ...request, input: null }))
				.rejects.toMatchObject({ code: "invalid-request" });
			await expect(service.enqueueUser({
				...request,
				input: { question: "x".repeat(200) },
			})).rejects.toMatchObject({ code: "invalid-request" });
			await expect(service.enqueueUser({ ...request, type: "missing" }))
				.rejects.toMatchObject({ code: "unknown-job-type" });
			await expect(service.enqueueUser({
				...request,
				input: new Date() as unknown as JsonValue,
			})).rejects.toMatchObject({ code: "invalid-request" });
			let sparse: JsonValue[] = [];
			sparse.length = 1;
			await expect(service.enqueueUser({ ...request, input: sparse }))
				.rejects.toMatchObject({ code: "invalid-request" });
			let cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			await expect(service.enqueueUser({ ...request, input: cyclic as JsonValue }))
				.rejects.toMatchObject({ code: "invalid-request" });
			await expect(service.enqueueUser({
				...request,
				input: { ["x".repeat(200)]: "value" },
			})).rejects.toMatchObject({ code: "invalid-request" });
		} finally {
			await storage.close();
		}
	});

	it("controls durable jobs and ignores publication failures", async () => {
		let { storage, channelId, lease } = await context();
		let warning = spyOn(console, "warn").mockImplementation(() => {});
		try {
			let service = new JobService({
				storage,
				registry: new JobRegistry([definition()]),
				lease: () => lease,
				publish: () => {
					throw new Error("socket unavailable");
				},
			});
			let queued = await service.enqueueUser({
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "request",
				input: { question: "Question" },
			});
			let paused = await service.pause({
				channelId,
				jobId: queued.job.id,
				expectedRevision: queued.job.revision,
			}, " owner unavailable ");
			expect(paused).toMatchObject({ state: "paused", reason: "owner unavailable" });
			let resumed = await service.resume({
				channelId,
				jobId: paused.id,
				expectedRevision: paused.revision,
			});
			expect(resumed.state).toBe("pending");
			let cancelled = await service.cancel({
				channelId,
				jobId: resumed.id,
				expectedRevision: resumed.revision,
			});
			expect(cancelled.state).toBe("cancelled");
			expect(warning).toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			await storage.close();
		}
	});

	it("bounds an asynchronous publication after persistence", async () => {
		let { storage, channelId, lease } = await context();
		let warning = spyOn(console, "warn").mockImplementation(() => {});
		try {
			let service = new JobService({
				storage,
				registry: new JobRegistry([definition()]),
				lease: () => lease,
				publish: () => new Promise(() => {}),
				publishTimeoutMs: 10,
			});
			let queued = await service.enqueueUser({
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "bounded-publish",
				input: { question: "Question" },
			});
			expect((await storage.jobs.get(channelId, queued.job.id))!.job.state).toBe("pending");
			expect(warning).toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			await storage.close();
		}
	});

	it("does not resume an unavailable persisted definition version", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let now = new Date();
			let queued = await storage.jobs.enqueue({
				id: "old-job",
				channelId,
				type: "test-report",
				version: 99,
				origin: "scheduler",
				targetKey: "test-report:old",
				idempotencyKey: "old-request",
				fingerprint: "old-fingerprint",
				input: { question: "Old" },
				availableAt: now,
				now,
				lease,
			});
			let paused = await storage.jobs.pause({
				channelId,
				jobId: queued.job.id,
				expectedRevision: queued.job.revision,
				reason: "unregistered-type",
				now,
				lease,
			});
			let service = new JobService({
				storage,
				registry: new JobRegistry([definition()]),
				lease: () => lease,
			});
			await expect(service.resume({
				channelId,
				jobId: paused.id,
				expectedRevision: paused.revision,
			})).rejects.toMatchObject({ code: "unregistered-version" });
			expect((await storage.jobs.get(channelId, paused.id))!.job.state).toBe("paused");
		} finally {
			await storage.close();
		}
	});

	it("validates and settles artifacts through the persisted definition version", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let published = false;
			let registered = {
				...definition(),
				publish: async (
					{ artifact, commit }: Parameters<NonNullable<JobDefinition["publish"]>>[0],
				) => {
					expect(artifact).toEqual({ report: "Result" });
					(artifact as { report: string }).report = "x".repeat(1_000);
					published = true;
					void commit();
				},
			};
			let service = new JobService({
				storage,
				registry: new JobRegistry([registered]),
				lease: () => lease,
			});
			let queued = await service.enqueueUser({
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "settle",
				input: { question: "Question" },
			});
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease,
			});
			let settlement = {
				channelId,
				jobId: queued.job.id,
				claimOwner: "worker",
				claimGeneration: claimed!.claimGeneration,
			};
			await expect(service.settle({ ...settlement, artifact: { report: "x".repeat(200) } }))
				.rejects.toMatchObject({ code: "invalid-request" });
			let completed = await service.settle({ ...settlement, artifact: { report: "  Result  " } });
			expect(completed.artifact?.value).toEqual({ report: "Result" });
			expect(published).toBe(true);
		} finally {
			await storage.close();
		}
	});

	it("does not settle when a publication hook times out before commit", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let registered = {
				...definition(),
				publish: () => new Promise<void>(() => {}),
			};
			let service = new JobService({
				storage,
				registry: new JobRegistry([registered]),
				lease: () => lease,
				hookTimeoutMs: 10,
			});
			let queued = await service.enqueueUser({
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "hook-timeout",
				input: { question: "Question" },
			});
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease,
			});
			await expect(service.settle({
				channelId,
				jobId: queued.job.id,
				claimOwner: "worker",
				claimGeneration: claimed!.claimGeneration,
				artifact: { report: "Result" },
			})).rejects.toThrow("timed out");
			let detail = await storage.jobs.get(channelId, queued.job.id);
			expect(detail).toMatchObject({ job: { state: "running" }, artifact: undefined });
		} finally {
			await storage.close();
		}
	});

	it("reports a rejected commit that a publication hook did not await", async () => {
		let { storage, channelId, lease } = await context();
		try {
			let registered = {
				...definition(),
				publish: async ({ commit }: Parameters<NonNullable<JobDefinition["publish"]>>[0]) => {
					void commit();
				},
			};
			let service = new JobService({
				storage,
				registry: new JobRegistry([registered]),
				lease: () => lease,
			});
			let queued = await service.enqueueUser({
				channelId,
				type: "test-report",
				targetKey: "target",
				idempotencyKey: "rejected-commit",
				input: { question: "Question" },
			});
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease,
			});
			await expect(service.settle({
				channelId,
				jobId: queued.job.id,
				claimOwner: "worker",
				claimGeneration: claimed!.claimGeneration + 1,
				artifact: { report: "Result" },
			})).rejects.toMatchObject({ failure: "conflict" });
			expect((await storage.jobs.get(channelId, queued.job.id))!.job.state).toBe("running");
		} finally {
			await storage.close();
		}
	});
});
