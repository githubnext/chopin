import { describe, expect, it } from "bun:test";

import { JobExecutionError, JobRegistry } from "./registry";
import { JobRunner } from "./runner";
import { JobService } from "./service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { JobDefinition } from "./registry";
import type { JobRunnerOptions, ResolvedJobCredential } from "./runner";
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
	attemptFailed?: JobRunnerOptions["attemptFailed"],
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
		attemptFailed,
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

	it("persists definition-owned progress while an attempt is running", async () => {
		let release = deferred<void>();
		let reached = deferred<void>();
		let registered = {
			...definition(async execution => {
				await execution.progress("work", "started");
				reached.resolve();
				await release.promise;
				await execution.progress("work", "completed");
				return { report: "complete" };
			}),
			progress: { work: "Researching public evidence" },
		};
		let value = await setup(registered);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await reached.promise;
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.progress.length === 1
			);
			expect((await value.service.get(value.channelId, queued.job.id))!.job.progress)
				.toMatchObject([{
					attempt: 1,
					stage: "work",
					label: "Researching public evidence",
					state: "started",
				}]);
			release.resolve();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
			expect((await value.service.get(value.channelId, queued.job.id))!.job.progress)
				.toMatchObject([{ state: "started" }, { state: "completed" }]);
		} finally {
			release.resolve();
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("renews a claim after delayed owner resolution without reclaiming the attempt", async () => {
		let started = deferred<void>();
		let release = deferred<JsonValue>();
		let registered = {
			...definition(
				async execution => {
					await execution.progress("work", "started");
					started.resolve();
					return release.promise;
				},
				"active-planner",
				2,
				1_000,
			),
			progress: { work: "Long-running work" },
		};
		let value = await setup(
			registered,
			async () => {
				await Bun.sleep(150);
				return owner();
			},
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await started.promise;
			await Bun.sleep(350);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { state: "running", attempts: 1, failures: 0, progress: [{ state: "started" }] },
			});
			release.resolve({ report: "complete" });
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
		} finally {
			release.resolve({ report: "complete" });
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("turns heartbeat loss into a bounded durable failure", async () => {
		let release = deferred<JsonValue>();
		let executions = 0;
		let registered = {
			...definition(
				async execution => {
					executions++;
					await execution.progress("work", "started");
					return release.promise;
				},
				"active-planner",
				2,
				1_000,
			),
			progress: { work: "Public web research" },
		};
		let value = await setup(
			registered,
			async () => ({
				...owner(),
				active: async () => {
					throw new Error("authorization unavailable");
				},
			}),
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					state: "failed",
					attempts: 1,
					failures: 1,
					reason: "attempts-exhausted:heartbeat-lost",
					progress: [{ state: "started" }, {
						state: "interrupted",
						reason: "heartbeat-lost",
					}],
				},
			});
			expect(executions).toBe(1);
		} finally {
			release.resolve({ report: "late" });
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("shutdown preserves an in-flight heartbeat-loss transition", async () => {
		let release = deferred<JsonValue>();
		let aborted = deferred<void>();
		let value = await setup(
			definition(
				execution => {
					execution.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					return release.promise;
				},
				"active-planner",
				2,
				1_000,
			),
			async () => ({
				...owner(),
				active: async () => {
					throw new Error("authorization unavailable");
				},
			}),
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await aborted.promise;
			await value.runner.shutdown();
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					state: "failed",
					failures: 1,
					reason: "attempts-exhausted:heartbeat-lost",
				},
			});
		} finally {
			release.resolve({ report: "late" });
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("retries heartbeat loss only after the aborted execution settles", async () => {
		let executions = 0;
		let validations = 0;
		let value = await setup(
			definition(
				async execution => {
					executions++;
					if (executions > 1) return { report: "complete" };
					return await new Promise<JsonValue>((_resolve, reject) => {
						execution.signal.addEventListener("abort", () => reject(execution.signal.reason), {
							once: true,
						});
					});
				},
				"active-planner",
				2,
				1_000,
			),
			async () => ({
				...owner(),
				active: async () => {
					if (++validations === 1) throw new Error("authorization unavailable");
					return true;
				},
			}),
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { state: "completed", attempts: 2, failures: 1 },
			});
			expect(executions).toBe(2);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("credential rotation wins its race with owner revocation", async () => {
		let credential = new AbortController();
		let executions = 0;
		let resolutions = 0;
		let started = deferred<void>();
		let registered = {
			...definition(
				async execution => {
					executions++;
					await execution.progress("work", "started");
					if (executions > 1) {
						await execution.progress("work", "completed");
						return { report: "complete" };
					}
					started.resolve();
					return await new Promise<JsonValue>((_resolve, reject) => {
						execution.signal.addEventListener("abort", () => reject(execution.signal.reason), {
							once: true,
						});
					});
				},
				"active-planner",
				2,
				1_000,
			),
			progress: { work: "Public web research" },
		};
		let value = await setup(registered, async () => {
			let resolved = owner();
			if (++resolutions === 1 && resolved.credential.kind === "active-planner") {
				resolved.credential = { ...resolved.credential, signal: credential.signal };
			}
			return resolved;
		});
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await started.promise;
			let rotating = value.runner.credentialsWillRotate("owner-session", 4);
			credential.abort(new Error("credential-rotated"));
			await rotating;
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "completed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					state: "completed",
					progress: [
						{ state: "started" },
						{
							state: "interrupted",
							reason: "credential-rotated",
						},
						{ state: "started" },
						{ state: "completed" },
					],
				},
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("owner revocation records why active work paused", async () => {
		let started = deferred<void>();
		let registered = {
			...definition(
				async execution => {
					await execution.progress("work", "started");
					started.resolve();
					return await new Promise<JsonValue>((_resolve, reject) => {
						execution.signal.addEventListener("abort", () => reject(execution.signal.reason), {
							once: true,
						});
					});
				},
				"active-planner",
				2,
				1_000,
			),
			progress: { work: "Public web research" },
		};
		let value = await setup(registered, async () => owner());
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await started.promise;
			await value.runner.ownerRevoked("owner-session");
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					state: "paused",
					progress: [{ state: "started" }, {
						state: "interrupted",
						reason: "owner-unavailable",
					}],
				},
			});
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
		let registered = {
			...definition(
				async execution => {
					await execution.progress("work", "started");
					return await new Promise<JsonValue>(() => {});
				},
				"none",
				2,
				25,
			),
			progress: { work: "Public web research" },
		};
		let value = await setup(registered);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					failures: 2,
					reason: "attempts-exhausted:attempt-timeout",
					progress: [
						{ state: "started" },
						{
							state: "interrupted",
							reason: "attempt-timeout",
						},
						{ state: "started" },
						{
							state: "interrupted",
							reason: "attempt-timeout",
						},
					],
				},
			});
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("turns a synchronous executor throw into a bounded failure", async () => {
		let reported: Array<{ id: string; message: string }> = [];
		let value = await setup(
			definition(
				() => {
					throw new Error("synchronous failure");
				},
				"none",
				1,
			),
			undefined,
			true,
			async (job, err) => {
				reported.push({ id: job.id, message: err instanceof Error ? err.message : "unknown" });
				throw new Error("diagnostic failure");
			},
		);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: { failures: 1, reason: "attempts-exhausted:attempt-error" },
			});
			expect(reported).toEqual([{ id: queued.job.id, message: "synchronous failure" }]);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("persists a definition-owned interruption reason", async () => {
		let registered = {
			...definition(
				async execution => {
					await execution.progress("public-web", "started");
					throw new JobExecutionError("web-search-unavailable");
				},
				"none",
				1,
			),
			progress: { "public-web": "Public web research" },
		};
		let value = await setup(registered);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, queued.job.id))?.job.state === "failed"
			);
			expect(await value.service.get(value.channelId, queued.job.id)).toMatchObject({
				job: {
					reason: "attempts-exhausted:web-search-unavailable",
					progress: [{ state: "started" }, {
						state: "interrupted",
						reason: "web-search-unavailable",
					}],
				},
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

	it("revives registered active-planner work paused while its definition was disabled", async () => {
		let value = await setup(
			definition(async () => ({ report: "restored" }), "active-planner"),
			async () => owner(),
		);
		try {
			let now = new Date();
			let queued = await value.storage.jobs.enqueue({
				id: crypto.randomUUID(),
				channelId: value.channelId,
				type: "test-job",
				version: 1,
				origin: "user",
				targetKey: "restored-target",
				idempotencyKey: crypto.randomUUID(),
				fingerprint: "restored-fingerprint",
				input: { value: "restored" },
				availableAt: now,
				now,
				lease: value.lease,
			});
			let paused = await value.storage.jobs.pause({
				channelId: value.channelId,
				jobId: queued.job.id,
				expectedRevision: queued.job.revision,
				reason: "unregistered-type",
				now,
				lease: value.lease,
			});
			value.runner.start();
			await value.runner.ownerAvailable(value.channelId);
			await waitFor(async () =>
				(await value.service.get(value.channelId, paused.id))?.job.state === "completed"
			);
			expect(await value.service.get(value.channelId, paused.id)).toMatchObject({
				job: { state: "completed", attempts: 1 },
				artifact: { value: { report: "restored" } },
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
		let registered = {
			...definition(async execution => {
				await execution.progress("work", "started");
				started = true;
				return result.promise;
			}),
			progress: { work: "Running cancellable work" },
		};
		let value = await setup(registered);
		try {
			let queued = await enqueue(value.service, value.channelId);
			value.runner.start();
			await waitFor(() => started);
			await value.service.cancel({
				channelId: value.channelId,
				jobId: queued.job.id,
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

	it("cancelChannel cancels pending work and fences later claims", async () => {
		let executions = 0;
		let value = await setup(definition(async () => {
			executions++;
			return { report: "unexpected" };
		}));
		try {
			let pending = await enqueue(value.service, value.channelId, "pending");
			await value.runner.cancelChannel(value.channelId);
			expect(await value.service.get(value.channelId, pending.job.id)).toMatchObject({
				job: { state: "cancelled", attempts: 0 },
			});

			let blocked = await enqueue(value.service, value.channelId, "blocked");
			value.runner.start();
			await waitFor(async () =>
				(await value.service.get(value.channelId, blocked.job.id))?.job.state === "cancelled"
			);
			expect(executions).toBe(0);
			expect(value.errors).toEqual([]);
		} finally {
			await value.runner.shutdown();
			await value.storage.close();
		}
	});

	it("cancelChannel aborts and cancels running work", async () => {
		let started = deferred<void>();
		let aborted = deferred<void>();
		let value = await setup(definition(async execution => {
			started.resolve();
			return await new Promise<JsonValue>((_resolve, reject) => {
				execution.signal.addEventListener("abort", () => {
					aborted.resolve();
					reject(execution.signal.reason);
				}, { once: true });
			});
		}));
		try {
			let running = await enqueue(value.service, value.channelId);
			value.runner.start();
			await started.promise;
			await value.runner.cancelChannel(value.channelId);
			await aborted.promise;
			expect(await value.service.get(value.channelId, running.job.id)).toMatchObject({
				job: { state: "cancelled", attempts: 1 },
				artifact: undefined,
			});
			expect(value.errors).toEqual([]);
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
