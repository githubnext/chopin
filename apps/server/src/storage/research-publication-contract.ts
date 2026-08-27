import { expect, it } from "bun:test";

import { deterministicChannelId } from "../channels/id";
import {
	backgroundJob,
	contractId as id,
	openedStorage as opened,
	userAndChannel,
} from "./contract-support";

import type { StorageFactory } from "./contract-support";
import type { CreateResearchWorkspace, JsonValue, Lease } from "./model";
import type { StorageAdapter } from "./port";

function deferred<T>(): PromiseWithResolvers<T> {
	return Promise.withResolvers<T>();
}

async function pauseJobRead(storage: StorageAdapter, channelId: string, jobId: string) {
	let entered = deferred<void>();
	let originalGet = storage.jobs.get;
	let answer = await originalGet(channelId, jobId);
	let release = deferred<typeof answer>();
	storage.jobs.get = () => {
		entered.resolve();
		return release.promise;
	};
	return {
		entered: entered.promise,
		release: () => release.resolve(answer),
	};
}
function researchWorkspace(
	channelId: string,
	createdBy: string,
	lease: Lease,
	overrides: Partial<CreateResearchWorkspace> = {},
): CreateResearchWorkspace {
	return {
		id: id("research-workspace"),
		channelId,
		title: "API compatibility research",
		proposedQuestion: "Which API contracts changed?",
		origin: "sidebar",
		createdBy,
		idempotencyKey: id("create-research"),
		fingerprint: id("research-fingerprint"),
		now: new Date("2026-01-07T03:04:05.000Z"),
		lease,
		...overrides,
	};
}

async function completedInitialResearch(
	storage: StorageAdapter,
	channelId: string,
	createdBy: string,
	lease: Lease,
	complete = true,
): Promise<{
	workspaceId: string;
	answerJobId: string;
	initial: {
		generation: string;
		epoch: string;
		source: string;
		sourceHash: string;
		document: Uint8Array;
		sidecar: JsonValue;
	};
}> {
	let draft = await storage.research.create(researchWorkspace(channelId, createdBy, lease));
	let confirmed = await storage.research.confirm({
		channelId,
		workspaceId: draft.workspace.id,
		turnId: id("publication-initial-turn"),
		messageId: id("publication-initial-message"),
		requestId: id("publication-confirmation"),
		fingerprint: "sha256:publication-confirmation",
		confirmedQuery: "Which API contracts changed?",
		confirmedBy: createdBy,
		now: new Date("2026-01-07T03:05:05.000Z"),
		lease,
	});
	let answer = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
		type: "research-answer",
		targetKey: `research-answer:workspace:${draft.workspace.id}:turn:${confirmed.turn.id}:answer`,
		idempotencyKey: id("publication-answer-request"),
		fingerprint: "sha256:publication-answer",
		now: new Date("2026-01-07T03:06:05.000Z"),
		availableAt: new Date("2026-01-07T03:06:05.000Z"),
	}));
	await storage.research.linkJob({
		channelId,
		workspaceId: draft.workspace.id,
		turnId: confirmed.turn.id,
		role: "answer",
		jobId: answer.job.id,
		now: new Date("2026-01-07T03:06:06.000Z"),
		lease,
	});
	if (complete) {
		let [claimed] = await storage.jobs.claim({
			channelId,
			claimOwner: "publication-worker",
			count: 1,
			ttlMs: 60_000,
			now: new Date("2026-01-07T03:06:07.000Z"),
			lease,
		});
		await storage.jobs.settle({
			channelId,
			jobId: answer.job.id,
			claimOwner: "publication-worker",
			claimGeneration: claimed!.claimGeneration,
			artifact: { title: "API compatibility report", source: "# API compatibility report\n" },
			now: new Date("2026-01-07T03:06:08.000Z"),
			lease,
		});
	}
	return {
		workspaceId: draft.workspace.id,
		answerJobId: answer.job.id,
		initial: {
			generation: id("publication-generation"),
			epoch: "publication-epoch",
			source: "# API compatibility report\n",
			sourceHash: "sha256:publication-report",
			document: new Uint8Array([7, 8, 9]),
			sidecar: {
				version: 1,
				revision: 0,
				documentSeq: 0,
				questions: [],
				openQuestions: [],
				threads: [],
				transcript: [],
			},
		},
	};
}

export function researchPublicationContract(factory: StorageFactory): void {
	it("publishes one initialized research child and preserves exact replays", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let ready = await completedInitialResearch(storage, channelId, userId, lease);
			let before = (await storage.research.get(channelId, ready.workspaceId))!.workspace;
			let input = {
				channelId,
				workspaceId: ready.workspaceId,
				answerJobId: ready.answerJobId,
				title: "API compatibility report",
				initial: ready.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			};
			let published = await storage.research.publishInitialReport(input);
			let childId = deterministicChannelId(repositoryId, ready.workspaceId);

			expect(published).toMatchObject({
				repeated: false,
				channel: {
					id: childId,
					parentChannelId: channelId,
					repositoryId,
					title: input.title,
					createdBy: userId,
					revision: 0,
				},
				workspace: {
					id: ready.workspaceId,
					publishedChannelId: childId,
					revision: before.revision + 1,
				},
			});
			let stored = await storage.collaboration.load(childId, input.now);
			expect(stored).toMatchObject({
				channel: { id: childId, parentChannelId: channelId },
				latestSequence: 0,
				snapshot: {
					channelId: childId,
					revision: 0,
					throughSequence: 0,
					epoch: ready.initial.epoch,
					source: ready.initial.source,
				},
				sidecar: ready.initial.sidecar,
			});
			expect([...stored!.snapshot!.document]).toEqual([7, 8, 9]);

			await storage.channels.archive({
				id: channelId,
				now: new Date(input.now.getTime() + 1),
			});
			expect(
				await storage.research.publishInitialReport({
					...input,
					initial: { ...ready.initial, generation: id("ignored-replay-generation") },
					now: new Date(input.now.getTime() + 2),
				}),
			).toEqual({ ...published, repeated: true });

			await storage.channels.archive({
				id: childId,
				now: new Date(input.now.getTime() + 3),
			});
			await expect(storage.channels.delete(childId))
				.rejects.toMatchObject({ failure: "conflict" });
			expect(await storage.channels.get(childId)).toBeDefined();
		} finally {
			await storage.close();
		}
	});

	it("never exposes a published child before its workspace link", async () => {
		let storage = await opened(factory);
		try {
			if (storage.driver !== "memory") return;
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let ready = await completedInitialResearch(storage, channelId, userId, lease);
			let paused = await pauseJobRead(storage, channelId, ready.answerJobId);
			let childId = deterministicChannelId(repositoryId, ready.workspaceId);
			let publishing = storage.research.publishInitialReport({
				channelId,
				workspaceId: ready.workspaceId,
				answerJobId: ready.answerJobId,
				title: "Atomic visibility report",
				initial: ready.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			});
			await paused.entered;
			paused.release();
			await Promise.resolve();
			let childRead = storage.channels.get(childId);
			let workspaceRead = storage.research.get(channelId, ready.workspaceId);
			let [child, detail] = await Promise.all([childRead, workspaceRead]);
			await publishing;
			expect(child && detail?.workspace.publishedChannelId !== child.id).toBe(false);
		} finally {
			await storage.close();
		}
	});

	it("rejects publication when its answer is superseded during validation", async () => {
		let storage = await opened(factory);
		try {
			if (storage.driver !== "memory") return;
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let ready = await completedInitialResearch(storage, channelId, userId, lease);
			let detail = (await storage.research.get(channelId, ready.workspaceId))!;
			let initialTurn = detail.turns[0]!;
			let paused = await pauseJobRead(storage, channelId, ready.answerJobId);
			let publishing = storage.research.publishInitialReport({
				channelId,
				workspaceId: ready.workspaceId,
				answerJobId: ready.answerJobId,
				title: "Superseded report",
				initial: ready.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			});
			await paused.entered;
			await storage.jobs.enqueue(backgroundJob(channelId, lease, {
				type: "research-answer",
				targetKey: `research-answer:workspace:${ready.workspaceId}:turn:${initialTurn.id}:answer`,
				idempotencyKey: id("concurrent-replacement-answer-request"),
				fingerprint: "sha256:concurrent-replacement-answer",
				now: new Date("2026-01-07T03:06:09.000Z"),
				availableAt: new Date("2026-01-07T03:06:09.000Z"),
			}));
			paused.release();

			await expect(publishing).rejects.toMatchObject({ failure: "conflict" });
			expect(
				await storage.channels.get(
					deterministicChannelId(repositoryId, ready.workspaceId),
				),
			).toBeUndefined();
			expect(
				(await storage.research.get(channelId, ready.workspaceId))!.workspace
					.publishedChannelId,
			).toBeUndefined();
		} finally {
			await storage.close();
		}
	});

	it("rejects publication when its parent is archived during validation", async () => {
		let storage = await opened(factory);
		try {
			if (storage.driver !== "memory") return;
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let ready = await completedInitialResearch(storage, channelId, userId, lease);
			let paused = await pauseJobRead(storage, channelId, ready.answerJobId);
			let publishing = storage.research.publishInitialReport({
				channelId,
				workspaceId: ready.workspaceId,
				answerJobId: ready.answerJobId,
				title: "Archived during publication",
				initial: ready.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			});
			await paused.entered;
			await storage.channels.archive({
				id: channelId,
				now: new Date("2026-01-07T03:07:04.000Z"),
			});
			paused.release();

			await expect(publishing).rejects.toMatchObject({ failure: "conflict" });
			expect(
				await storage.channels.get(
					deterministicChannelId(repositoryId, ready.workspaceId),
				),
			).toBeUndefined();
			expect(
				(await storage.research.get(channelId, ready.workspaceId))!.workspace
					.publishedChannelId,
			).toBeUndefined();
		} finally {
			await storage.close();
		}
	});

	it("rejects incomplete, stale, foreign, and archived publication atomically", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let stale = await completedInitialResearch(storage, channelId, userId, lease);
			let staleDetail = (await storage.research.get(channelId, stale.workspaceId))!;
			let initialTurn = staleDetail.turns[0]!;
			await storage.jobs.enqueue(backgroundJob(channelId, lease, {
				type: "research-answer",
				targetKey: `research-answer:workspace:${stale.workspaceId}:turn:${initialTurn.id}:answer`,
				idempotencyKey: id("replacement-answer-request"),
				fingerprint: "sha256:replacement-answer",
				now: new Date("2026-01-07T03:06:09.000Z"),
				availableAt: new Date("2026-01-07T03:06:09.000Z"),
			}));
			let staleInput = {
				channelId,
				workspaceId: stale.workspaceId,
				answerJobId: stale.answerJobId,
				title: "Stale report",
				initial: stale.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			};
			await expect(storage.research.publishInitialReport(staleInput))
				.rejects.toMatchObject({ failure: "conflict" });
			expect(await storage.channels.get(deterministicChannelId(repositoryId, stale.workspaceId)))
				.toBeUndefined();
			expect((await storage.research.get(channelId, stale.workspaceId))!.workspace)
				.toEqual(staleDetail.workspace);

			let incompleteParent = await storage.channels.create({
				id: id("incomplete-publication-parent"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Incomplete publication parent",
				createdBy: userId,
				now: new Date("2026-01-07T03:04:05.500Z"),
			});
			let incomplete = await completedInitialResearch(
				storage,
				incompleteParent.id,
				userId,
				lease,
				false,
			);
			await expect(storage.research.publishInitialReport({
				channelId: incompleteParent.id,
				workspaceId: incomplete.workspaceId,
				answerJobId: incomplete.answerJobId,
				title: "Incomplete report",
				initial: incomplete.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			})).rejects.toMatchObject({ failure: "conflict" });

			let foreignChannel = await storage.channels.create({
				id: id("foreign-publication-parent"),
				repositoryId: id("foreign-publication-repository"),
				repositoryOwner: "octo-org",
				repositoryName: "foreign",
				title: "Foreign publication parent",
				createdBy: userId,
				now: new Date("2026-01-07T03:04:06.000Z"),
			});
			let foreign = await completedInitialResearch(storage, foreignChannel.id, userId, lease);
			await expect(storage.research.publishInitialReport({
				...staleInput,
				answerJobId: foreign.answerJobId,
			})).rejects.toMatchObject({ failure: "conflict" });

			let archivedParent = await storage.channels.create({
				id: id("archived-publication-parent"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Archived publication parent",
				createdBy: userId,
				now: new Date("2026-01-07T03:04:07.000Z"),
			});
			let archived = await completedInitialResearch(storage, archivedParent.id, userId, lease);
			let archivedBefore = (await storage.research.get(
				archivedParent.id,
				archived.workspaceId,
			))!.workspace;
			await storage.channels.archive({
				id: archivedParent.id,
				now: new Date("2026-01-07T03:07:04.000Z"),
			});
			await expect(storage.research.publishInitialReport({
				channelId: archivedParent.id,
				workspaceId: archived.workspaceId,
				answerJobId: archived.answerJobId,
				title: "Archived report",
				initial: archived.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			})).rejects.toMatchObject({ failure: "conflict" });
			expect(
				await storage.channels.get(
					deterministicChannelId(repositoryId, archived.workspaceId),
				),
			).toBeUndefined();
			expect(
				(await storage.research.get(
					archivedParent.id,
					archived.workspaceId,
				))!.workspace,
			).toEqual(archivedBefore);
		} finally {
			await storage.close();
		}
	});

	it("reserves available titles and slugs during research publication", async () => {
		let storage = await opened(factory);
		try {
			let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
			let collision = await completedInitialResearch(storage, channelId, userId, lease);
			await storage.channels.create({
				id: id("title-collision"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "API compatibility report",
				createdBy: userId,
				now: new Date("2026-01-07T03:06:09.000Z"),
			});
			let collisionPublished = await storage.research.publishInitialReport({
				channelId,
				workspaceId: collision.workspaceId,
				answerJobId: collision.answerJobId,
				title: "api COMPATIBILITY report",
				initial: collision.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			});
			expect(collisionPublished.channel.title).toBe("api COMPATIBILITY report (2)");

			let slugParent = await storage.channels.create({
				id: id("slug-publication-parent"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Slug publication parent",
				createdBy: userId,
				now: new Date("2026-01-07T03:04:06.000Z"),
			});
			let slugReady = await completedInitialResearch(storage, slugParent.id, userId, lease);
			await storage.channels.create({
				id: id("slug-collision"),
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Collision report!",
				createdBy: userId,
				now: new Date("2026-01-07T03:06:10.000Z"),
			});
			let published = await storage.research.publishInitialReport({
				channelId: slugParent.id,
				workspaceId: slugReady.workspaceId,
				answerJobId: slugReady.answerJobId,
				title: "Collision report?",
				initial: slugReady.initial,
				now: new Date("2026-01-07T03:07:05.000Z"),
				lease,
			});
			expect(published.channel.slug).toBe("collision-report-2");
		} finally {
			await storage.close();
		}
	});
}
