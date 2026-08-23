import { describe, expect, it } from "bun:test";

import { documentSummaryDefinition, StaleDocumentSummaryError } from "./document-summary";
import { JobRegistry } from "./registry";
import { JobService } from "./service";
import { DocumentSummaryCoordinator } from "./summary-coordinator";
import { sourceHash } from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";

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
		idempotencyKey: "request",
		fingerprint: "fingerprint",
		input: { revision: value.revision, sourceHash: value.sourceHash, generatorVersion: 1 },
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

function execution(value: DocumentTarget): JobExecution<{
	revision: number;
	sourceHash: string;
	generatorVersion: 1;
}> {
	return {
		job: job(value),
		input: { revision: value.revision, sourceHash: value.sourceHash, generatorVersion: 1 },
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
	_expected: { revision: number; sourceHash: string; generatorVersion: 1 },
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
	it("summarizes the exact canonical target without persisting source", async () => {
		let current = target();
		let received = "";
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async (_execution, source) => {
				received = source;
				return { summary: "  A release plan.  ", model: "summary-model" };
			},
		});

		let result = await definition.execute(execution(current));
		expect(received).toBe(current.source);
		expect(result).toEqual({
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1,
			summary: "A release plan.",
			model: "summary-model",
		});
		let storedInput = definition.input.parse({
			revision: current.revision,
			sourceHash: current.sourceHash,
			generatorVersion: 1,
		});
		expect("source" in storedInput).toBe(false);
		expect(() => definition.input.parse({ ...storedInput, source: current.source }))
			.toThrow("unexpected fields");
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
				return { summary: "unexpected", model: "summary-model" };
			},
		});
		expect(await definition.execute(execution(current))).toMatchObject({
			summary: "The document is empty.",
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
			engine: async () => ({ summary: "unused", model: "summary-model" }),
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
	it("debounces to the newest target and replays idempotently", async () => {
		let current = target();
		let definition = documentSummaryDefinition({
			config: { agent: true, model: "summary-model" },
			current: async () => current,
			refresh: async () => {},
			commitCurrent,
			engine: async () => ({ summary: "summary", model: "summary-model" }),
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
			expect((await value.storage.jobs.get(value.channelId, page!.jobs[0]!.id))!.job.input)
				.toEqual({ revision: 4, sourceHash: second.sourceHash, generatorVersion: 1 });
			await coordinator.ensure(value.channelId);
			expect((await value.storage.jobs.list(value.channelId, 10))!.jobs).toHaveLength(1);
			coordinator.close();
		} finally {
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
