import { describe, expect, it } from "bun:test";

import { DocumentDescriptionProjector } from "./document-description";
import { documentSummaryDefinition, StaleDocumentSummaryError } from "./document-summary";
import { JobRegistry } from "./registry";
import { JobService } from "./service";
import { DocumentSummaryCoordinator } from "./summary-coordinator";
import { sourceHash } from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { DocumentSummaryInput } from "./document-summary";
import type { JobExecution } from "./registry";
import type { DocumentTarget } from "../plan/service";
import type { BackgroundJob, Lease } from "../storage/model";

function target(source = "# Plan\n\nDescribe the release.\n", revision = 3): DocumentTarget {
	return {
		channelId: "channel",
		revision,
		source,
		sourceHash: sourceHash(source),
	};
}

function job(value: DocumentTarget): BackgroundJob {
	let now = new Date();
	return {
		id: "job",
		channelId: value.channelId,
		type: "document-summary",
		version: 1,
		origin: "scheduler",
		targetKey: "document-summary:document",
		targetGeneration: 1,
		idempotencyKey: `description-v1:${value.revision}:${value.sourceHash}`,
		fingerprint: "fingerprint",
		input: {
			revision: value.revision,
			sourceHash: value.sourceHash,
			generatorVersion: 1,
			output: "description",
		},
		state: "running",
		revision: 2,
		attempts: 1,
		failures: 0,
		claimGeneration: 1,
		claimOwner: "worker",
		claimBinding: undefined,
		claimExpiresAt: new Date(now.getTime() + 60_000),
		availableAt: now,
		reason: undefined,
		progress: [],
		createdAt: now,
		updatedAt: now,
	};
}

function execution(value: DocumentTarget): JobExecution<DocumentSummaryInput> {
	return {
		job: job(value),
		input: {
			revision: value.revision,
			sourceHash: value.sourceHash,
			generatorVersion: 1,
			output: "description",
		},
		credential: {
			kind: "active-planner",
			token: "ghu_owner",
			ownerSessionId: "session",
			ownerGeneration: 2,
			credentialRevision: 3,
			expiresAt: new Date(Date.now() + 60_000),
			authorize: async () => true,
		},
		signal: new AbortController().signal,
		deadline: new Date(Date.now() + 60_000),
		progress: async () => {},
	};
}

async function commitCurrent(
	_channelId: string,
	_expected: DocumentSummaryInput,
	commit: () => Promise<void>,
): Promise<boolean> {
	await commit();
	return true;
}

async function serviceContext(definition: ReturnType<typeof documentSummaryDefinition>): Promise<{
	storage: MemoryStorage;
	service: JobService;
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
		title: "Summary",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 60_000);
	if (!lease) throw new Error("lease unavailable");
	let service = new JobService({
		storage,
		registry: new JobRegistry([definition]),
		lease: () => lease,
	});
	return { storage, service, channelId, lease };
}

describe("document summary definition", () => {
	it("describes the exact canonical target without persisting source", async () => {
		let current = target();
		let received = "";
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async (_execution, source) => {
				received = source;
				return { description: "  Plan for the release  ", model: "summary-model" };
			},
		});

		let result = await definition.execute(execution(current));
		expect(received).toBe(current.source);
		expect(result).toEqual({
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1,
			output: "description",
			description: "Plan for the release",
			model: "summary-model",
		});
		let storedInput = definition.input.parse({
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1,
			output: "description",
		});
		expect("source" in storedInput).toBe(false);
		expect(() => definition.input.parse({ ...storedInput, source: current.source }))
			.toThrow("unexpected fields");
	});

	it("reads legacy V1 summary artifacts without treating them as descriptions", () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ description: "unused", model: "summary-model" }),
		});
		expect(definition.artifact.parse({
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1,
			summary: "A legacy executive summary.\n\nIt may span lines.",
			model: "summary-model",
		})).toMatchObject({
			summary: "A legacy executive summary.\n\nIt may span lines.",
		});
	});

	it("runs a persisted markerless V1 request with the new description behavior", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ description: "Plan for the release", model: "summary-model" }),
		});
		let legacyInput = {
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1 as const,
		};
		let legacyExecution = {
			...execution(current),
			job: { ...job(current), input: legacyInput },
			input: legacyInput,
		};
		expect(await definition.execute(legacyExecution)).toMatchObject({
			output: "description",
			description: "Plan for the release",
		});
	});

	it("rejects descriptions containing more than one physical line", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({
				description: "Plan for the release\nWith implementation details",
				model: "summary-model",
			}),
		});
		await expect(definition.execute(execution(current))).rejects.toThrow(
			"description must contain exactly one line",
		);
	});

	it("avoids model spend for an empty document", async () => {
		let current = target("", 0);
		let called = false;
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => {
				called = true;
				return { description: "unexpected", model: "summary-model" };
			},
		});
		expect(await definition.execute(execution(current))).toMatchObject({
			description: "Empty document",
		});
		expect(called).toBe(false);
	});

	it("refreshes and refuses stale execution and publication", async () => {
		let original = target();
		let current = target("# Changed\n", 4);
		let refreshed: DocumentTarget[] = [];
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async value => {
				refreshed.push(value);
			},
			commitCurrent: async () => false,
			engine: async () => ({ description: "unused", model: "summary-model" }),
		});
		await expect(definition.execute(execution(original))).rejects.toBeInstanceOf(
			StaleDocumentSummaryError,
		);
		let committed = false;
		await expect(definition.publish!({
			job: job(original),
			artifact: { summary: "old" },
			commit: async () => {
				committed = true;
			},
		})).rejects.toBeInstanceOf(StaleDocumentSummaryError);
		expect(refreshed).toEqual([current, current]);
		expect(committed).toBe(false);
	});
});

describe("document summary coordinator", () => {
	it("recovers a completed description projection through an idempotent enqueue", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ description: "Plan for testing", model: "summary-model" }),
		});
		let value = await serviceContext(definition);
		let projected: string[] = [];
		try {
			let requested = { ...current, channelId: value.channelId };
			let queued = await value.service.enqueueScheduler({
				channelId: value.channelId,
				type: "document-summary",
				targetKey: "document",
				idempotencyKey: `description-v1:${current.revision}:${current.sourceHash}`,
				input: {
					revision: current.revision,
					sourceHash: current.sourceHash,
					generatorVersion: 1,
					output: "description",
				},
			});
			let [claimed] = await value.storage.jobs.claim({
				channelId: value.channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 60_000,
				now: new Date(),
				lease: value.lease,
			});
			let completed = await value.service.settle({
				channelId: value.channelId,
				jobId: queued.job.id,
				claimOwner: "worker",
				claimGeneration: claimed!.claimGeneration,
				artifact: {
					revision: current.revision,
					sourceHash: current.sourceHash,
					generatorVersion: 1,
					output: "description",
					description: "Plan for testing",
					model: "summary-model",
				},
			});
			expect(completed.job.state).toBe("completed");

			let projector = new DocumentDescriptionProjector({
				storage: value.storage,
				lease: () => value.lease,
				now: () => new Date("2026-01-02T03:04:05.000Z"),
				publish: channel => {
					projected.push(channel.description!.value);
				},
			});
			let coordinator = new DocumentSummaryCoordinator({
				service: value.service,
				current: async channelId => ({ ...requested, channelId }),
				completed: job => projector.jobChanged(job),
			});
			await coordinator.ensure(value.channelId);
			await coordinator.ensure(value.channelId);
			expect((await value.storage.channels.get(value.channelId))?.description).toMatchObject({
				value: "Plan for testing",
				revision: 1,
				planRevision: current.revision,
				jobId: queued.job.id,
			});
			expect(projected).toEqual(["Plan for testing"]);
			coordinator.close();
		} finally {
			await value.storage.close();
		}
	});

	it("debounces to the newest target and replays idempotently", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ description: "Plan for testing", model: "summary-model" }),
		});
		let value = await serviceContext(definition);
		let timers: Array<{ cancelled: boolean; action: () => void }> = [];
		try {
			let coordinator = new DocumentSummaryCoordinator({
				service: value.service,
				current: async channelId => ({ ...current, channelId }),
				debounceMs: 10,
				after: (_delay, action) => {
					let timer = { cancelled: false, action };
					timers.push(timer);
					return () => timer.cancelled = true;
				},
			});
			let first = { ...current, channelId: value.channelId };
			let second = {
				...target("# New plan\n", 4),
				channelId: value.channelId,
			};
			coordinator.schedule(first);
			coordinator.schedule(second);
			expect(timers[0]!.cancelled).toBe(true);
			current = { ...second, channelId: "channel" };
			timers[1]!.action();
			await waitFor(async () =>
				(await value.storage.jobs.list(value.channelId, 10))!.jobs.length === 1
			);
			let page = await value.storage.jobs.list(value.channelId, 10);
			expect(page!.jobs[0]).toMatchObject({ targetGeneration: 1, state: "pending" });
			let stored = (await value.storage.jobs.get(value.channelId, page!.jobs[0]!.id))!.job;
			expect(stored.input).toEqual({
				revision: 4,
				sourceHash: second.sourceHash,
				generatorVersion: 1,
				output: "description",
			});
			expect(stored.idempotencyKey).toBe(`description-v1:4:${second.sourceHash}`);
			await coordinator.ensure(value.channelId);
			expect((await value.storage.jobs.list(value.channelId, 10))!.jobs).toHaveLength(1);
			coordinator.close();
		} finally {
			await value.storage.close();
		}
	});

	it("suspends pending and admitted scheduling until resumed", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ description: "Plan for testing", model: "summary-model" }),
		});
		let value = await serviceContext(definition);
		let timers: Array<{ cancelled: boolean; action: () => void }> = [];
		let currentCalls = 0;
		let coordinator = new DocumentSummaryCoordinator({
			service: value.service,
			current: async channelId => {
				currentCalls++;
				return { ...current, channelId };
			},
			debounceMs: 10,
			after: (_delay, action) => {
				let timer = { cancelled: false, action };
				timers.push(timer);
				return () => timer.cancelled = true;
			},
		});
		try {
			let scheduled = { ...current, channelId: value.channelId };
			coordinator.schedule(scheduled);
			let admitted = coordinator.enqueueNow(scheduled);
			await coordinator.suspend(value.channelId);
			await admitted;
			expect(timers[0]!.cancelled).toBe(true);
			timers[0]!.action();

			coordinator.schedule(scheduled);
			await coordinator.ensure(value.channelId);
			await coordinator.enqueueNow(scheduled);
			expect(currentCalls).toBe(0);
			expect((await value.storage.jobs.list(value.channelId, 10))!.jobs).toEqual([]);

			coordinator.resume(value.channelId);
			await coordinator.ensure(value.channelId);
			expect(currentCalls).toBe(2);
			expect((await value.storage.jobs.list(value.channelId, 10))!.jobs).toHaveLength(1);
		} finally {
			coordinator.close();
			await value.storage.close();
		}
	});
});

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	let deadline = Date.now() + 500;
	while (!await check()) {
		if (Date.now() > deadline) throw new Error("condition did not become true");
		await Bun.sleep(5);
	}
}
