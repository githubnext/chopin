import { describe, expect, it } from "bun:test";

import { JobRegistry } from "./registry";
import { JobRunner } from "./runner";
import { JobService } from "./service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { JobDefinition } from "./registry";
import type { ResolvedJobCredential } from "./runner";
import type { JsonValue } from "../storage/model";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	let promise = new Promise<T>((success, failure) => {
		resolve = success;
		reject = failure;
	});
	return { promise, resolve, reject };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	let deadline = Date.now() + timeoutMs;
	while (!await check()) {
		if (Date.now() >= deadline) throw new Error("condition did not become true");
		await Bun.sleep(5);
	}
}

function definition(
	execute: JobDefinition["execute"],
	credential: "active-planner" | "none" = "none",
	maxAttempts = 2,
	timeoutMs = 200,
): JobDefinition {
	return {
		type: "test-job",
		version: 1,
		label: "Test job",
		description: "Exercises the process runner.",
		origins: ["scheduler", "user"],
		credential,
		limits: {
			timeoutMs,
			maxAttempts,
			maxAiCredits: 16,
			maxInputBytes: 256,
			maxArtifactBytes: 256,
		},
		input: {
			parse(value) {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("input");
				return value;
			},
		},
		artifact: {
			parse(value) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					throw new Error("artifact");
				}
				return value;
			},
		},
		execute,
	};
}

async function setup(
	registered: JobDefinition,
	resolve: () => Promise<ResolvedJobCredential | undefined> = async () => undefined,
	enabled = true,
) {
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
		title: "Runner",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("lease unavailable");
	let registry = new JobRegistry([registered]);
	let runner: JobRunner | undefined;
	let service = new JobService({
		storage,
		registry,
		lease: () => lease,
		onChange: job => runner?.notify(job),
	});
	let errors: unknown[] = [];
	runner = new JobRunner({
		storage,
		service,
		registry,
		lease: () => lease,
		resolveActivePlanner: () => resolve(),
		enabled,
		globalConcurrency: 4,
		ownerConcurrency: 1,
		pollMs: 5,
		claimTtlMs: 1_000,
		heartbeatMs: 100,
		retryBaseMs: 5,
		retryMaxMs: 20,
		shutdownGraceMs: 50,
		fatal: err => errors.push(err),
	});
	return { storage, channelId, lease, service, runner, errors };
}

async function enqueue(
	service: JobService,
	channelId: string,
	target: string = crypto.randomUUID(),
) {
	return service.enqueueScheduler({
		channelId,
		type: "test-job",
		targetKey: target,
		idempotencyKey: crypto.randomUUID(),
		input: { value: target },
	});
}

function owner(sessionId = "owner-session"): ResolvedJobCredential {
	return {
		credential: {
			kind: "active-planner",
			token: "ghu_owner",
			ownerSessionId: sessionId,
			ownerGeneration: 3,
			credentialRevision: 4,
			expiresAt: new Date(Date.now() + 60_000),
			authorize: async () => true,
		},
		ownerKey: sessionId,
		binding: {
			kind: "active-planner",
			ownerSessionId: sessionId,
			ownerGeneration: 3,
			credentialRevision: 4,
		},
		active: async () => true,
		release: () => {},
	};
}

describe("background job runner", () => {
	it("executes and atomically settles a registered job", async () => {
		let value = await setup(definition(async execution => ({ result: execution.input })));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
			let detail = await value.service.get(value.channelId, queued.job.id);
			expect(detail).toMatchObject({
				job: { state: "completed", attempts: 1 },
				artifact: { value: { result: { value: expect.any(String) } } },
			});
			expect(value.errors).toEqual([]);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("requeues a failed attempt and succeeds within its attempt limit", async () => {
		let attempts = 0;
		let value = await setup(definition(async () => {
			if (++attempts === 1) throw new Error("provider failed");
			return { report: "ok" };
		}));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
			expect((await value.service.get(value.channelId, queued.job.id))!.job.attempts).toBe(2);
			expect(attempts).toBe(2);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("counts timeouts as durable failures and stops at the limit", async () => {
		let value = await setup(definition(
			() => new Promise<JsonValue>(() => {}),
			"none",
			2,
			25,
		));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { failures: 2, reason: "attempts-exhausted:attempt-timeout" },
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("turns a synchronous executor throw into a bounded failure", async () => {
		let value = await setup(definition(
			() => {
				throw new Error("synchronous failure");
			},
			"none",
			1,
		));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { failures: 1, reason: "attempts-exhausted:attempt-error" },
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("pauses active-planner work when no owner is available", async () => {
		let value = await setup(definition(async () => ({ report: "unused" }), "active-planner"));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "paused"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { reason: "owner-unavailable" },
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("persists a token-free owner binding and limits execution per owner", async () => {
		let releases = [deferred<JsonValue>(), deferred<JsonValue>()];
		let active = 0;
		let maximum = 0;
		let started = 0;
		let value = await setup(
			definition(async () => {
				let index = started++;
				active++;
				maximum = Math.max(maximum, active);
				try {
					return await releases[index]!.promise;
				} finally {
					active--;
				}
			}, "active-planner"),
			async () => owner(),
		);
		try {
			let first = await enqueue(value.service, value.channelId, "first");
			let second = await enqueue(value.service, value.channelId, "second");
			value.runner.start();
			await waitFor(() => started === 1);
			let running = await value.storage.jobs.get(value.channelId, first.job.id);
			if (!running?.job.claimBinding) {
				running = await value.storage.jobs.get(value.channelId, second.job.id);
			}
			expect(running!.job.claimBinding).toEqual({
				kind: "active-planner",
				ownerSessionId: "owner-session",
				ownerGeneration: 3,
				credentialRevision: 4,
			});
			expect(JSON.stringify(running!.job.claimBinding)).not.toContain("ghu_owner");
			releases[0]!.resolve({ report: "first" });
			await waitFor(() => started === 2);
			releases[1]!.resolve({ report: "second" });
			await waitFor(async () => {
				let states = await Promise.all([
					value.service.get(value.channelId, first.job.id),
					value.service.get(value.channelId, second.job.id),
				]);
				return states.every(item => item?.job.state === "completed");
			});
			expect(maximum).toBe(1);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("cancellation prevents a blocked handler from publishing late output", async () => {
		let result = deferred<JsonValue>();
		let started = false;
		let value = await setup(definition(async () => {
			started = true;
			return result.promise;
		}));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(() => started);
			let current = await value.storage.jobs.get(value.channelId, queued.job.id);
			await value.service.cancel({
				channelId: value.channelId,
				jobId: queued.job.id,
				expectedRevision: current!.job.revision,
			});
			result.resolve({ report: "too late" });
			await Bun.sleep(20);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { state: "cancelled" },
				artifact: undefined,
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("requeues active work before shutdown returns", async () => {
		let result = deferred<JsonValue>();
		let started = false;
		let value = await setup(definition(async () => {
			started = true;
			return result.promise;
		}));
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(() => started);
			await value.runner.shutdown();
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { state: "pending", reason: "runner-shutdown" },
			});
			result.resolve({ report: "late" });
		} finally {
			await value.storage.close();
		}
	});

	it("does not claim work when the hosted agent is disabled", async () => {
		let executed = false;
		let value = await setup(
			definition(async () => {
				executed = true;
				return { report: "unexpected" };
			}),
			async () => undefined,
			false,
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await Bun.sleep(20);
			expect(executed).toBe(false);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { state: "pending", attempts: 0 },
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});
});
