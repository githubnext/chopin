import { describe, expect, it } from "bun:test";

import { deterministicChannelId } from "../channels/id";
import { StorageError } from "./errors";
import { BACKGROUND_JOB_PROGRESS_LIMIT } from "./model";

import type { CreateResearchWorkspace, EnqueueBackgroundJob, JsonValue, Lease } from "./model";
import type { StorageAdapter } from "./port";

type Factory = () => StorageAdapter | Promise<StorageAdapter>;

function id(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

async function opened(factory: Factory): Promise<StorageAdapter> {
	let storage = await factory();
	await storage.migrate();
	return storage;
}

function attempt<T>(action: () => Promise<T>): Promise<T> {
	return Promise.resolve().then(action);
}

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

async function userAndChannel(storage: StorageAdapter): Promise<{
	userId: string;
	sessionId: string;
	channelId: string;
	repositoryId: string;
	lease: Lease;
}> {
	let now = new Date("2026-01-02T03:04:05.000Z");
	let userId = id("user");
	let sessionId = id("session");
	let channelId = id("channel");
	let repositoryId = id("repository");
	await storage.users.put({
		id: userId,
		login: "octocat",
		avatarUrl: "https://example.test/a",
		now,
	});
	await storage.sessions.create({
		id: sessionId,
		userId,
		expiresAt: new Date("2026-02-02T03:04:05.000Z"),
		createdAt: now,
	});
	await storage.channels.create({
		id: channelId,
		repositoryId,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire(
		id("channel-writer"),
		id("instance"),
		60_000,
	);
	if (!lease) throw new Error("test could not acquire its storage lease");
	return { userId, sessionId, channelId, repositoryId, lease };
}

function backgroundJob(
	channelId: string,
	lease: Lease,
	overrides: Partial<EnqueueBackgroundJob> = {},
): EnqueueBackgroundJob {
	let now = overrides.now ?? new Date();
	return {
		id: id("job"),
		channelId,
		type: "document-summary",
		version: 1,
		origin: "scheduler",
		targetKey: "document-summary",
		idempotencyKey: id("enqueue"),
		fingerprint: id("fingerprint"),
		input: { revision: 1 },
		availableAt: now,
		now,
		lease,
		...overrides,
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

/** The behavioral gate every built-in storage adapter must pass. */
export function storageContract(name: string, factory: Factory): void {
	describe(`${name} storage`, () => {
		it("keeps only process-lifetime registry metadata for a login session", async () => {
			let storage = await opened(factory);
			try {
				let now = new Date("2026-01-02T03:04:05.000Z");
				let userId = id("user");
				let sessionId = id("session");
				await storage.users.put({
					id: userId,
					login: "mona",
					avatarUrl: "https://example.test/mona",
					now,
				});
				await storage.sessions.create({
					id: sessionId,
					userId,
					expiresAt: new Date("2026-01-02T04:04:05.000Z"),
					createdAt: now,
				});

				let active = await storage.sessions.get(
					sessionId,
					new Date("2026-01-02T03:30:00.000Z"),
				);
				expect(active).toMatchObject({ id: sessionId, userId });
				expect(
					await storage.sessions.get(sessionId, new Date("2026-01-02T04:04:05.000Z")),
				).toBeUndefined();
				expect(await storage.sessions.deleteExpired(new Date("2026-01-02T05:00:00.000Z")))
					.toBe(1);
				expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("deletes all session registries while preserving durable agent context", async () => {
			let storage = await opened(factory);
			try {
				let { sessionId, channelId, lease } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				let claimed = await storage.channels.claimAgentOwner(channelId, sessionId, now);
				await storage.channels.updateAgentContext({
					channelId,
					ownerSessionId: sessionId,
					generation: claimed.generation,
					summary: "durable summary",
					transcriptCursor: 7,
					status: "ready",
					now,
				});
				let reset = await storage.sessions.deleteAll(now, lease, 60_000);
				expect(reset.deleted).toBeGreaterThan(0);
				expect(reset.lease.fencing).toBe(lease.fencing);
				expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
				let saved = await storage.collaboration.load(channelId, now);
				expect(saved!.agent).toMatchObject({
					generation: claimed.generation,
					summary: "durable summary",
					transcriptCursor: 7,
					status: "unavailable",
				});
				expect(saved!.agent!.ownerSessionId).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("reports whether adding a project changed navigation and keeps its original order", async () => {
			let storage = await opened(factory);
			try {
				let now = new Date("2026-01-02T03:04:05.000Z");
				let userId = id("user");
				await storage.users.put({
					id: userId,
					login: "mona",
					avatarUrl: "https://example.test/mona",
					now,
				});
				let first = await storage.navigation.addProject({
					userId,
					repositoryId: "R_first",
					repositoryOwner: "githubnext",
					repositoryName: "chopin",
					now,
				});
				let second = await storage.navigation.addProject({
					userId,
					repositoryId: "R_second",
					repositoryOwner: "githubnext",
					repositoryName: "second",
					now: new Date(now.getTime() + 1),
				});
				let repeated = await storage.navigation.addProject({
					userId,
					repositoryId: "R_first",
					repositoryOwner: "githubnext",
					repositoryName: "chopin",
					now: new Date(now.getTime() + 2),
				});

				expect(first.added).toBe(true);
				expect(second.added).toBe(true);
				expect(repeated).toEqual({ project: first.project, added: false });
				expect((await storage.navigation.projects(userId)).map(project => project.repositoryId))
					.toEqual(["R_first", "R_second"]);
				expect(await storage.navigation.snapshot(userId)).toMatchObject({
					projects: [{ repositoryId: "R_first" }, { repositoryId: "R_second" }],
					navigation: undefined,
					lastDocumentRepositoryId: undefined,
				});
			} finally {
				await storage.close();
			}
		});

		it("stores the last document with a monotonic navigation revision", async () => {
			let storage = await opened(factory);
			try {
				let now = new Date("2026-01-02T03:04:05.000Z");
				let { userId, channelId } = await userAndChannel(storage);
				let first = await storage.navigation.setLastDocument(userId, channelId, now);
				let repeated = await storage.navigation.setLastDocument(userId, channelId, now);

				expect(first.revision).toBe(0);
				expect(repeated).toEqual({ ...first, revision: 1 });
				expect(await storage.navigation.get(userId)).toEqual(repeated);
				expect(await storage.navigation.snapshot(userId)).toMatchObject({
					navigation: repeated,
					lastDocumentRepositoryId: expect.any(String),
				});
				expect(
					await storage.navigation.setLastDocumentIfCurrent(
						userId,
						repeated.revision + 1,
						undefined,
						new Date(now.getTime() + 1),
					),
				).toEqual({ navigation: repeated, updated: false });
				expect(
					await storage.navigation.setLastDocumentIfCurrent(
						userId,
						repeated.revision,
						undefined,
						new Date(now.getTime() + 2),
					),
				).toMatchObject({ navigation: { lastDocumentId: undefined }, updated: true });
			} finally {
				await storage.close();
			}
		});

		it("rejects a last document that does not exist", async () => {
			let storage = await opened(factory);
			try {
				let { userId } = await userAndChannel(storage);
				await expect(storage.navigation.setLastDocument(
					userId,
					id("missing-channel"),
					new Date("2026-01-02T03:04:05.000Z"),
				)).rejects.toMatchObject({ failure: "missing" });
				expect(await storage.navigation.get(userId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("records a deep-link visit without adding a project when its document is missing", async () => {
			let storage = await opened(factory);
			try {
				let { userId } = await userAndChannel(storage);
				await expect(storage.navigation.recordVisit({
					userId,
					repositoryId: "R_missing",
					repositoryOwner: "githubnext",
					repositoryName: "missing",
					documentId: id("missing-channel"),
					now: new Date("2026-01-02T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "missing" });
				expect(await storage.navigation.projects(userId)).toEqual([]);
				expect(await storage.navigation.get(userId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("rejects a deep-link visit whose document belongs to another repository", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId } = await userAndChannel(storage);
				await expect(storage.navigation.recordVisit({
					userId,
					repositoryId: id("other-repository"),
					repositoryOwner: "githubnext",
					repositoryName: "other",
					documentId: channelId,
					now: new Date("2026-01-02T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "missing" });
				expect(await storage.navigation.projects(userId)).toEqual([]);
				expect(await storage.navigation.get(userId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("adds a project and records a deep-link visit together", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let saved = await storage.navigation.recordVisit({
					userId,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					documentId: channelId,
					now: new Date("2026-01-02T03:04:05.000Z"),
				});
				expect(saved.lastDocumentId).toBe(channelId);
				expect(await storage.navigation.projects(userId)).toMatchObject([{ repositoryId }]);
				expect(await storage.navigation.firstDocument(userId, [repositoryId])).toBe(channelId);
				expect(await storage.navigation.firstDocument(userId, ["R_unavailable"]))
					.toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("lists only a repository's channels in stable order", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let other = id("repository");
				await storage.channels.create({
					id: id("other-channel"),
					repositoryId: other,
					repositoryOwner: "elsewhere",
					repositoryName: "private",
					title: "Not this repository",
					createdBy: userId,
					now: new Date("2026-01-03T03:04:05.000Z"),
				});

				let page = await storage.channels.list(repositoryId, 20);
				expect(page.channels).toHaveLength(1);
				expect(page.channels[0]!.repositoryId).toBe(repositoryId);
				expect(page.next).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("stores only one level of repository-local child channels", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId: parentChannelId, repositoryId } = await userAndChannel(storage);
				let childId = id("child-channel");
				let child = await storage.channels.create({
					id: childId,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Research report",
					createdBy: userId,
					parentChannelId,
					now: new Date("2026-01-03T03:04:05.000Z"),
					initial: {
						generation: id("generation"),
						epoch: "epoch-child",
						source: "# Research report\n",
						sourceHash: "sha256:child",
						document: new Uint8Array([1, 2, 3]),
						sidecar: { version: 1, revision: 0 },
					},
				});

				expect(child.parentChannelId).toBe(parentChannelId);
				expect((await storage.channels.get(childId))?.parentChannelId).toBe(parentChannelId);
				expect((await storage.channels.list(repositoryId, 20)).channels)
					.toContainEqual(child);
				let stored = await storage.collaboration.load(childId, child.createdAt);
				expect(stored?.channel.parentChannelId).toBe(parentChannelId);
				expect(stored?.snapshot).toMatchObject({
					channelId: childId,
					epoch: "epoch-child",
					source: "# Research report\n",
				});

				await expect(storage.channels.create({
					id: id("cross-repository-child"),
					repositoryId: id("other-repository"),
					repositoryOwner: "githubnext",
					repositoryName: "other",
					title: "Cross-repository child",
					createdBy: userId,
					parentChannelId,
					now: new Date("2026-01-04T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.channels.create({
					id: id("grandchild-channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Nested child",
					createdBy: userId,
					parentChannelId: childId,
					now: new Date("2026-01-04T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "conflict" });

				await storage.channels.archive({
					id: parentChannelId,
					now: new Date("2026-01-05T03:04:05.000Z"),
				});
				await expect(storage.channels.delete(parentChannelId))
					.rejects.toMatchObject({ failure: "conflict" });
			} finally {
				await storage.close();
			}
		});

		it("archives and restores channels without hiding direct reads", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let original = (await storage.channels.get(channelId))!;
				let fallback = await storage.channels.create({
					id: id("fallback-channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Fallback plan",
					createdBy: userId,
					now: new Date("2026-01-01T03:04:05.000Z"),
				});
				await storage.navigation.recordVisit({
					userId,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					documentId: channelId,
					now: original.updatedAt,
				});

				let archived = await storage.channels.archive({ id: channelId, now: original.updatedAt });
				expect(archived).toMatchObject({
					changed: true,
					channel: {
						id: channelId,
						title: original.title,
						slug: original.slug,
						revision: original.revision,
					},
				});
				expect(archived.channel.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
				expect(archived.channel.archivedAt).toEqual(archived.channel.updatedAt);
				expect(
					await storage.channels.archive({
						id: channelId,
						now: new Date("2026-01-05T03:04:05.000Z"),
					}),
				).toEqual({ channel: archived.channel, changed: false });

				expect((await storage.channels.list(repositoryId, 1)).channels.map(value => value.id))
					.toEqual([fallback.id]);
				expect(
					(await storage.channels.list(repositoryId, 1, undefined, undefined, true)).channels
						.map(value => value.id),
				).toEqual([channelId]);
				expect((await storage.channels.scan(repositoryId, 1)).channels.map(value => value.id))
					.toEqual([fallback.id]);
				expect(
					(await storage.channels.scan(repositoryId, 1, undefined, true)).channels
						.map(value => value.id),
				).toEqual([channelId]);
				expect((await storage.channels.get(channelId))?.archivedAt)
					.toEqual(archived.channel.archivedAt);
				expect((await storage.channels.resolve(repositoryId, original.slug))?.id).toBe(channelId);
				await expect(storage.channels.rename({
					id: channelId,
					title: original.title,
					now: new Date("2026-01-06T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.navigation.setLastDocument(
					userId,
					channelId,
					new Date("2026-01-06T03:04:05.000Z"),
				)).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.navigation.recordVisit({
					userId,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					documentId: channelId,
					now: new Date("2026-01-06T03:04:05.000Z"),
				})).rejects.toMatchObject({ failure: "conflict" });

				let snapshot = await storage.navigation.snapshot(userId);
				expect(snapshot.navigation?.lastDocumentId).toBe(channelId);
				expect(snapshot.lastDocumentRepositoryId).toBeUndefined();
				expect(await storage.navigation.firstDocument(userId, [repositoryId])).toBe(fallback.id);
				expect(
					await storage.navigation.setLastDocumentIfCurrent(
						userId,
						snapshot.navigation?.revision,
						fallback.id,
						new Date("2026-01-06T03:04:05.000Z"),
					),
				).toMatchObject({ navigation: { lastDocumentId: fallback.id }, updated: true });

				let restored = await storage.channels.restore({
					id: channelId,
					now: archived.channel.updatedAt,
				});
				expect(restored.changed).toBe(true);
				expect(restored.channel.archivedAt).toBeUndefined();
				expect(restored.channel.revision).toBe(original.revision);
				expect(restored.channel.updatedAt.getTime())
					.toBeGreaterThan(archived.channel.updatedAt.getTime());
				expect((await storage.channels.list(repositoryId, 1)).channels[0]?.id).toBe(channelId);
				expect(
					await storage.channels.restore({
						id: channelId,
						now: new Date("2026-01-07T03:04:05.000Z"),
					}),
				).toEqual({ channel: restored.channel, changed: false });
			} finally {
				await storage.close();
			}
		});

		it("deletes only archived channels and permits clean identity reuse", async () => {
			let storage = await opened(factory);
			try {
				let { userId, sessionId, channelId, repositoryId, lease } = await userAndChannel(storage);
				let operationId = id("delete-operation");
				let workspaceInput = researchWorkspace(channelId, userId, lease, {
					id: id("delete-workspace"),
					idempotencyKey: id("delete-workspace-request"),
					fingerprint: "sha256:delete-workspace",
				});
				let createdWorkspace = await storage.research.create(workspaceInput);
				let confirmation = {
					channelId,
					workspaceId: createdWorkspace.workspace.id,
					turnId: id("delete-turn"),
					messageId: id("delete-member-message"),
					requestId: id("delete-confirmation"),
					fingerprint: "sha256:delete-confirmation",
					confirmedQuery: "Which state must be deleted?",
					confirmedBy: userId,
					now: new Date("2026-01-07T03:05:05.000Z"),
					lease,
				};
				let confirmed = await storage.research.confirm(confirmation);
				let jobInput = backgroundJob(channelId, lease, {
					id: id("delete-job"),
					type: "research-answer",
					targetKey:
						`research-answer:workspace:${workspaceInput.id}:turn:${confirmation.turnId}:answer`,
					idempotencyKey: id("delete-job-request"),
					fingerprint: "sha256:delete-job",
					now: new Date("2026-01-07T03:06:05.000Z"),
					availableAt: new Date("2026-01-07T03:06:05.000Z"),
				});
				let queued = await storage.jobs.enqueue(jobInput);
				let [claimed] = await storage.jobs.claim({
					channelId,
					claimOwner: "delete-worker",
					count: 1,
					ttlMs: 60_000,
					now: new Date("2026-01-07T03:06:06.000Z"),
					lease,
				});
				await storage.jobs.settle({
					channelId,
					jobId: queued.job.id,
					claimOwner: "delete-worker",
					claimGeneration: claimed!.claimGeneration,
					artifact: { answer: "all channel-owned state" },
					now: new Date("2026-01-07T03:06:07.000Z"),
					lease,
				});
				await storage.research.linkJob({
					channelId,
					workspaceId: workspaceInput.id,
					turnId: confirmed.turn.id,
					role: "answer",
					jobId: jobInput.id,
					now: new Date("2026-01-07T03:06:08.000Z"),
					lease,
				});
				let agentMessage = {
					channelId,
					workspaceId: workspaceInput.id,
					id: id("delete-agent-message"),
					turnId: confirmed.turn.id,
					text: "Delete this transcript with its document.",
					sourceJobId: jobInput.id,
					now: new Date("2026-01-07T03:06:09.000Z"),
					lease,
				};
				await storage.research.appendAgentMessage(agentMessage);
				await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 0,
					operationId,
					epoch: "delete-epoch",
					update: new Uint8Array([1, 2, 3]),
					sidecar: { deletion: "seeded" },
					events: [{
						id: id("delete-event"),
						kind: "delete:test",
						payload: { seeded: true },
						createdAt: new Date("2026-01-07T03:07:05.000Z"),
					}],
					now: new Date("2026-01-07T03:07:05.000Z"),
				});
				await storage.collaboration.checkpoint({
					channelId,
					lease,
					expectedRevision: 1,
					generation: id("delete-generation"),
					revision: 1,
					throughSequence: 1,
					epoch: "delete-epoch",
					source: "# Delete me\n",
					sourceHash: "sha256:delete-me",
					document: new Uint8Array([4, 5, 6]),
					sidecar: { deletion: "seeded" },
					createdAt: new Date("2026-01-07T03:08:05.000Z"),
				});
				await storage.channels.claimAgentOwner(
					channelId,
					sessionId,
					new Date("2026-01-07T03:09:05.000Z"),
				);
				await storage.navigation.setLastDocument(
					userId,
					channelId,
					new Date("2026-01-07T03:09:05.000Z"),
				);
				let renamed = await storage.channels.rename({
					id: channelId,
					title: "Launch plan",
					now: new Date("2026-01-08T03:04:05.000Z"),
				});
				await expect(storage.channels.delete(channelId))
					.rejects.toMatchObject({ failure: "conflict" });
				await storage.channels.archive({
					id: channelId,
					now: new Date("2026-01-09T03:04:05.000Z"),
				});
				expect(await storage.channels.delete(channelId)).toBe(true);
				expect(await storage.channels.delete(channelId)).toBe(false);

				expect(await storage.channels.get(channelId)).toBeUndefined();
				expect(await storage.channels.resolve(repositoryId, "release-plan")).toBeUndefined();
				expect(await storage.channels.resolve(repositoryId, renamed.channel.slug)).toBeUndefined();
				expect(await storage.collaboration.load(channelId, new Date())).toBeUndefined();
				expect(await storage.channels.readAgent(channelId, new Date())).toBeUndefined();
				expect(await storage.jobs.list(channelId, 10)).toBeUndefined();
				expect(await storage.jobs.get(channelId, jobInput.id)).toBeUndefined();
				expect(await storage.research.list(channelId, 10)).toEqual([]);
				expect(await storage.research.get(channelId, workspaceInput.id)).toBeUndefined();
				expect((await storage.navigation.get(userId))?.lastDocumentId).toBeUndefined();
				expect((await storage.navigation.snapshot(userId)).lastDocumentRepositoryId)
					.toBeUndefined();

				let recreated = await storage.channels.create({
					id: channelId,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Release plan",
					createdBy: userId,
					now: new Date("2026-01-10T03:04:05.000Z"),
				});
				expect(recreated).toMatchObject({ id: channelId, slug: "release-plan", revision: 0 });
				expect(recreated.archivedAt).toBeUndefined();
				let aliasReuse = await storage.channels.create({
					id: id("alias-reuse-channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Launch plan",
					createdBy: userId,
					now: new Date("2026-01-10T03:04:06.000Z"),
				});
				expect(aliasReuse.slug).toBe("launch-plan");
				let clean = (await storage.collaboration.load(channelId, new Date()))!;
				expect(clean).toMatchObject({
					latestSequence: 0,
					snapshot: undefined,
					updates: [],
					events: [],
					sidecar: null,
					agent: undefined,
				});
				expect(
					await storage.collaboration.commit({
						channelId,
						lease,
						expectedRevision: 0,
						operationId,
						epoch: "recreated-epoch",
						events: [],
						now: new Date("2026-01-10T03:05:05.000Z"),
					}),
				).toEqual({ revision: 1, sequence: 1, repeated: false });

				let recreatedWorkspace = await storage.research.create({
					...workspaceInput,
					now: new Date("2026-01-10T03:06:05.000Z"),
				});
				expect(recreatedWorkspace.repeated).toBe(false);
				let recreatedConfirmation = await storage.research.confirm({
					...confirmation,
					now: new Date("2026-01-10T03:06:06.000Z"),
				});
				expect(recreatedConfirmation.repeated).toBe(false);
				let recreatedJob = await storage.jobs.enqueue({
					...jobInput,
					availableAt: new Date("2026-01-10T03:06:07.000Z"),
					now: new Date("2026-01-10T03:06:07.000Z"),
				});
				expect(recreatedJob.repeated).toBe(false);
				expect((await storage.jobs.get(channelId, jobInput.id))?.artifact).toBeUndefined();
				expect(
					(await storage.research.linkJob({
						channelId,
						workspaceId: workspaceInput.id,
						turnId: confirmation.turnId,
						role: "answer",
						jobId: jobInput.id,
						now: new Date("2026-01-10T03:06:08.000Z"),
						lease,
					})).repeated,
				).toBe(false);
				expect(
					(await storage.research.appendAgentMessage({
						...agentMessage,
						now: new Date("2026-01-10T03:06:09.000Z"),
					})).repeated,
				).toBe(false);
			} finally {
				await storage.close();
			}
		});

		it("renames channel metadata without advancing its collaboration revision", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease, repositoryId } = await userAndChannel(storage);
				let before = await storage.channels.get(channelId);
				let now = new Date("2026-01-03T03:04:05.000Z");
				let renamed = await storage.channels.rename({
					id: channelId,
					title: "Launch plan",
					now,
				});

				expect(renamed).toMatchObject({ changed: true, channel: { title: "Launch plan" } });
				expect(renamed.channel.updatedAt).toEqual(now);
				expect(renamed.channel.revision).toBe(before!.revision);
				expect((await storage.channels.list(repositoryId, 20, undefined, "launch")).channels)
					.toHaveLength(1);
				expect((await storage.channels.list(repositoryId, 20, undefined, "release")).channels)
					.toEqual([]);
				await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 0,
					operationId: id("operation"),
					epoch: "epoch-1",
					events: [],
					now: new Date("2026-01-02T12:00:00.000Z"),
				});
				expect((await storage.channels.get(channelId))!.updatedAt).toEqual(now);

				let repeated = await storage.channels.rename({
					id: channelId,
					title: "Launch plan",
					now: new Date("2026-01-04T03:04:05.000Z"),
				});
				expect(repeated.changed).toBe(false);
				expect(repeated.channel.updatedAt).toEqual(now);
			} finally {
				await storage.close();
			}
		});

		it("publishes searchable document descriptions without changing document recency", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease, repositoryId } = await userAndChannel(storage);
				let before = (await storage.channels.get(channelId))!;
				let first = await storage.channels.publishDescription({
					channelId,
					description: "RFC about payment migration",
					planRevision: 3,
					sourceHash: `sha256:${"a".repeat(64)}`,
					generatorVersion: 1,
					jobId: id("description-job"),
					now: new Date("2026-01-03T03:04:05.000Z"),
					lease,
				});
				expect(first).toMatchObject({
					changed: true,
					channel: {
						description: {
							value: "RFC about payment migration",
							revision: 1,
							planRevision: 3,
							generatorVersion: 1,
						},
					},
				});
				expect(first.channel.revision).toBe(before.revision);
				expect(first.channel.updatedAt).toEqual(before.updatedAt);
				expect((await storage.channels.get(channelId))?.description).toEqual(
					first.channel.description,
				);
				expect((await storage.channels.resolve(repositoryId, before.slug))?.description)
					.toEqual(first.channel.description);
				expect((await storage.channels.list(repositoryId, 20, undefined, "PAYMENT")).channels)
					.toHaveLength(1);
				expect((await storage.channels.scan(repositoryId, 20)).channels[0]?.description)
					.toEqual(first.channel.description);
				expect((await storage.collaboration.load(channelId, new Date()))?.channel.description)
					.toEqual(first.channel.description);

				let repeated = await storage.channels.publishDescription({
					channelId,
					description: "RFC about payment migration",
					planRevision: 3,
					sourceHash: `sha256:${"a".repeat(64)}`,
					generatorVersion: 1,
					jobId: first.channel.description!.jobId,
					now: new Date("2026-01-04T03:04:05.000Z"),
					lease,
				});
				expect(repeated).toEqual({ channel: first.channel, changed: false });

				let newer = await storage.channels.publishDescription({
					channelId,
					description: "Plan for payment migration",
					planRevision: 4,
					sourceHash: `sha256:${"b".repeat(64)}`,
					generatorVersion: 1,
					jobId: id("description-job"),
					now: new Date("2026-01-05T03:04:05.000Z"),
					lease,
				});
				expect(newer.channel.description).toMatchObject({
					value: "Plan for payment migration",
					revision: 2,
					planRevision: 4,
				});
				expect(newer.channel.updatedAt).toEqual(before.updatedAt);
			} finally {
				await storage.close();
			}
		});

		it("keeps renamed document titles unique within their repository", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				let other = await storage.channels.create({
					id: id("channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Launch plan",
					createdBy: userId,
					now,
				});

				expect(storage.channels.rename({
					id: channelId,
					title: "launch PLAN",
					now,
				})).rejects.toBeInstanceOf(StorageError);
				let recased = await storage.channels.rename({
					id: other.id,
					title: "LAUNCH PLAN",
					now,
				});
				expect(recased.channel.title).toBe("LAUNCH PLAN");
			} finally {
				await storage.close();
			}
		});

		it("keeps document titles unique within a repository without regard to case", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				await storage.channels.create({
					id: id("channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Release notes",
					createdBy: userId,
					now,
				});
				expect(storage.channels.create({
					id: id("channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "release NOTES",
					createdBy: userId,
					now,
				})).rejects.toBeInstanceOf(StorageError);
			} finally {
				await storage.close();
			}
		});

		it("resolves canonical and historical document slugs without rebinding aliases", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let original = await storage.channels.get(channelId);
				expect(original?.slug).toBe("release-plan");
				expect((await storage.channels.resolve(repositoryId, "release-plan"))?.id)
					.toBe(channelId);

				let renamed = await storage.channels.rename({
					id: channelId,
					title: "Résumé 計画",
					now: new Date("2026-01-03T03:04:05.000Z"),
				});
				expect(renamed.channel.slug).toBe("résumé-計画");
				expect((await storage.channels.resolve(repositoryId, "release-plan"))?.id)
					.toBe(channelId);
				expect((await storage.channels.resolve(repositoryId, "résumé-計画"))?.id)
					.toBe(channelId);

				let restored = await storage.channels.rename({
					id: channelId,
					title: "Release plan",
					now: new Date("2026-01-04T03:04:05.000Z"),
				});
				expect(restored.channel.slug).toBe("release-plan");
				await storage.channels.rename({
					id: channelId,
					title: "Launch plan",
					now: new Date("2026-01-05T03:04:05.000Z"),
				});

				let replacement = await storage.channels.create({
					id: id("replacement-channel"),
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Release plan",
					createdBy: userId,
					now: new Date("2026-01-06T03:04:05.000Z"),
				});
				expect(replacement.slug).toBe("release-plan-2");
				expect((await storage.channels.resolve(repositoryId, "release-plan"))?.id)
					.toBe(channelId);
				expect((await storage.channels.resolve(repositoryId, "release-plan-2"))?.id)
					.toBe(replacement.id);
				expect(await storage.channels.resolve(repositoryId, "missing"))
					.toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("atomically disambiguates different titles with the same document slug", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				let create = (channelId: string, title: string) =>
					storage.channels.create({
						id: channelId,
						repositoryId,
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title,
						createdBy: userId,
						now,
					});
				let channels = await Promise.all([
					create(id("channel"), "Bright road"),
					create(id("channel"), "Bright-road!"),
				]);
				expect(channels.map(channel => channel.slug).sort()).toEqual([
					"bright-road",
					"bright-road-2",
				]);
			} finally {
				await storage.close();
			}
		});

		it("atomically reserves one title for concurrent creators", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				let create = (id: string) =>
					storage.channels.create({
						id,
						repositoryId,
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title: "bright-road",
						createdBy: userId,
						now,
					});
				let results = await Promise.allSettled([create(id("channel")), create(id("channel"))]);
				expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
				expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
			} finally {
				await storage.close();
			}
		});

		it("paginates a case-insensitive title search independently from the full list", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				for (let title of ["Draft map", "Draft release", "Roadmap"]) {
					await storage.channels.create({
						id: id("channel"),
						repositoryId,
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title,
						createdBy: userId,
						now,
					});
				}
				let first = await storage.channels.list(repositoryId, 1, undefined, "DRAFT");
				expect(first.channels.map(channel => channel.title)).toHaveLength(1);
				expect(first.channels[0]!.title).toMatch(/^Draft/);
				let second = await storage.channels.list(repositoryId, 1, first.next, "draft");
				expect(second.channels.map(channel => channel.title)).toHaveLength(1);
				expect(second.channels[0]!.title).toMatch(/^Draft/);
				expect(second.next).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("treats title-search punctuation as literal text", async () => {
			let storage = await opened(factory);
			try {
				let { userId, repositoryId } = await userAndChannel(storage);
				let now = new Date("2026-01-03T03:04:05.000Z");
				for (let title of ["Budget 100%_\\plan", "Budget 100abcplan"]) {
					await storage.channels.create({
						id: id("channel"),
						repositoryId,
						repositoryOwner: "octo-org",
						repositoryName: "score",
						title,
						createdBy: userId,
						now,
					});
				}
				let page = await storage.channels.list(repositoryId, 20, undefined, "100%_\\plan");
				expect(page.channels.map(channel => channel.title)).toEqual(["Budget 100%_\\plan"]);
			} finally {
				await storage.close();
			}
		});

		it("scans repository channels through updates without changing its creation cursor", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
				let second = id("channel");
				let third = id("channel");
				await storage.channels.create({
					id: second,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Second plan",
					createdBy: userId,
					now: new Date("2026-01-03T03:04:05.000Z"),
				});
				await storage.channels.create({
					id: third,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Third plan",
					createdBy: userId,
					now: new Date("2026-01-04T03:04:05.000Z"),
				});

				let first = await storage.channels.scan(repositoryId, 2);
				await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 0,
					operationId: id("operation"),
					epoch: "epoch-1",
					events: [],
					now: new Date("2026-01-05T03:04:05.000Z"),
				});
				let next = await storage.channels.scan(repositoryId, 2, first.next);

				expect(first.channels.map(channel => channel.id)).toEqual([third, second]);
				expect(next.channels.map(channel => channel.id)).toEqual([channelId]);
				expect(next.next).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("publishes an initialized channel and checkpoint atomically", async () => {
			let storage = await opened(factory);
			try {
				let now = new Date("2026-01-02T03:04:05.000Z");
				let userId = id("user");
				let channelId = id("channel");
				let sidecar = {
					version: 1,
					revision: 0,
					origin: { idempotencyKey: "create-plan-1", fingerprint: "request-1" },
				};
				await storage.users.put({
					id: userId,
					login: "octocat",
					avatarUrl: "https://example.test/a",
					now,
				});
				await storage.channels.create({
					id: channelId,
					repositoryId: id("repository"),
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Created plan",
					createdBy: userId,
					now,
					initial: {
						generation: id("generation"),
						epoch: "epoch-created",
						source: "# Created\n",
						sourceHash: "sha256:created",
						document: new Uint8Array([1, 2, 3]),
						sidecar,
					},
				});

				let stored = await storage.collaboration.load(channelId, now);
				expect(stored).toBeDefined();
				expect(stored!.latestSequence).toBe(0);
				expect(stored!.sidecar).toEqual(sidecar);
				expect(stored!.snapshot).toMatchObject({
					channelId,
					revision: 0,
					throughSequence: 0,
					epoch: "epoch-created",
					source: "# Created\n",
					createdAt: now,
				});
				expect([...stored!.snapshot!.document]).toEqual([1, 2, 3]);
			} finally {
				await storage.close();
			}
		});

		it("assigns the first active session as the agent owner", async () => {
			let storage = await opened(factory);
			try {
				let { userId, sessionId, channelId } = await userAndChannel(storage);
				let second = id("session");
				let now = new Date("2026-01-03T03:04:05.000Z");
				await storage.sessions.create({
					id: second,
					userId,
					expiresAt: new Date("2026-02-03T03:04:05.000Z"),
					createdAt: now,
				});

				let first = await storage.channels.claimAgentOwner(channelId, sessionId, now);
				expect(first.ownerSessionId).toBe(sessionId);
				expect(await storage.channels.readAgent(channelId, now)).toMatchObject({
					channel: { id: channelId },
					agent: { ownerSessionId: sessionId, generation: first.generation },
				});
				expect(await storage.channels.readAgent(id("missing-channel"), now)).toBeUndefined();
				expect((await storage.channels.claimAgentOwner(channelId, second, now)).ownerSessionId)
					.toBe(sessionId);
				expect(await storage.channels.clearAgentOwner(channelId, second, first.generation, now))
					.toBe(false);
				expect(
					await storage.channels.clearAgentOwner(channelId, sessionId, first.generation, now),
				).toBe(true);
				let reclaimed = await storage.channels.claimAgentOwner(channelId, sessionId, now);
				expect(reclaimed.generation).toBeGreaterThan(first.generation);
				expect(
					await storage.channels.clearAgentOwner(channelId, sessionId, first.generation, now),
				).toBe(false);
				expect(
					await storage.channels.clearAgentOwner(
						channelId,
						sessionId,
						reclaimed.generation,
						now,
					),
				).toBe(true);
				expect((await storage.channels.claimAgentOwner(channelId, second, now)).ownerSessionId)
					.toBe(second);
			} finally {
				await storage.close();
			}
		});

		it("revokes agent ownership when its login session expires", async () => {
			let storage = await opened(factory);
			try {
				let { sessionId, channelId } = await userAndChannel(storage);
				let claimed = await storage.channels.claimAgentOwner(
					channelId,
					sessionId,
					new Date("2026-01-03T03:04:05.000Z"),
				);
				await storage.sessions.deleteExpired(new Date("2026-03-03T03:04:05.000Z"));

				let stored = await storage.collaboration.load(
					channelId,
					new Date("2026-03-03T03:04:05.000Z"),
				);
				expect(stored!.agent!.ownerSessionId).toBeUndefined();
				expect(stored!.agent!.status).toBe("unavailable");
				try {
					await storage.channels.updateAgentContext({
						channelId,
						ownerSessionId: sessionId,
						generation: claimed.generation,
						summary: "stale",
						transcriptCursor: 1,
						status: "ready",
						now: new Date("2026-03-03T03:04:05.000Z"),
					});
					expect.unreachable();
				} catch (err) {
					expect(err).toBeInstanceOf(StorageError);
					expect((err as StorageError).failure).toBe("conflict");
				}
			} finally {
				await storage.close();
			}
		});

		it("commits updates, sidecar state and events once", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let operationId = id("operation");
				let sidecar: JsonValue = { questions: [{ id: "question-1", status: "open" }] };
				let input = {
					channelId,
					lease,
					expectedRevision: 0,
					operationId,
					epoch: "epoch-1",
					update: new Uint8Array([99, 100]),
					sidecar,
					events: [{
						id: id("event"),
						kind: "chat:message",
						payload: { text: "hello" },
						createdAt: new Date("2026-01-04T03:04:05.000Z"),
					}],
					now: new Date("2026-01-04T03:04:05.000Z"),
				};

				let committed = await storage.collaboration.commit(input);
				expect(committed).toEqual({ revision: 1, sequence: 1, repeated: false });
				expect(await storage.collaboration.commit(input)).toEqual({
					revision: 1,
					sequence: 1,
					repeated: true,
				});

				let stored = await storage.collaboration.load(
					channelId,
					new Date("2026-01-04T03:04:05.000Z"),
				);
				expect(stored!.channel.revision).toBe(1);
				expect([...stored!.updates[0]!.update]).toEqual([99, 100]);
				expect(stored!.events).toHaveLength(1);
				expect(stored!.sidecar).toEqual(sidecar);

				try {
					await storage.collaboration.commit({
						...input,
						expectedRevision: 1,
						operationId: id("duplicate-event"),
					});
					expect.unreachable();
				} catch (err) {
					expect(err).toBeInstanceOf(StorageError);
					expect((err as StorageError).failure).toBe("conflict");
				}

				try {
					await storage.collaboration.commit({ ...input, operationId: id("stale") });
					expect.unreachable();
				} catch (err) {
					expect(err).toBeInstanceOf(StorageError);
					expect((err as StorageError).failure).toBe("conflict");
				}
			} finally {
				await storage.close();
			}
		});

		it("fences archived collaboration writes except sidecar-only maintenance", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let archivedAt = new Date("2026-01-04T03:04:05.000Z");
				await storage.channels.archive({ id: channelId, now: archivedAt });

				await expect(attempt(() =>
					storage.collaboration.commit({
						channelId,
						lease,
						expectedRevision: 0,
						operationId: id("archived-normal-commit"),
						epoch: "archived-epoch",
						sidecar: { maintenance: false },
						events: [],
						now: archivedAt,
					})
				)).rejects.toMatchObject({ failure: "conflict" });

				let maintenance = await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 0,
					operationId: id("archived-sidecar-commit"),
					epoch: "archived-epoch",
					sidecar: { maintenance: true },
					events: [],
					now: new Date(archivedAt.getTime() + 1),
					allowArchived: true,
				});
				expect(maintenance).toEqual({ revision: 1, sequence: 1, repeated: false });

				await expect(attempt(() =>
					storage.collaboration.commit({
						channelId,
						lease,
						expectedRevision: 1,
						operationId: id("archived-update-commit"),
						epoch: "archived-epoch",
						update: new Uint8Array([1]),
						events: [],
						now: new Date(archivedAt.getTime() + 2),
						allowArchived: true,
					})
				)).rejects.toMatchObject({ failure: "conflict" });
				await expect(attempt(() =>
					storage.collaboration.commit({
						channelId,
						lease,
						expectedRevision: 1,
						operationId: id("archived-event-commit"),
						epoch: "archived-epoch",
						events: [{
							id: id("archived-event"),
							kind: "archive:test",
							payload: { rejected: true },
							createdAt: new Date(archivedAt.getTime() + 3),
						}],
						now: new Date(archivedAt.getTime() + 3),
						allowArchived: true,
					})
				)).rejects.toMatchObject({ failure: "conflict" });

				await expect(attempt(() =>
					storage.collaboration.replace({
						channelId,
						lease,
						expectedRevision: 1,
						operationId: id("archived-replacement"),
						generation: id("archived-generation"),
						epoch: "replacement-epoch",
						source: "# Rejected replacement\n",
						sourceHash: "sha256:archived-replacement",
						document: new Uint8Array([2]),
						sidecar: { maintenance: false },
						now: new Date(archivedAt.getTime() + 4),
					})
				)).rejects.toMatchObject({ failure: "conflict" });

				let stored = await storage.collaboration.load(channelId, new Date());
				expect(stored).toMatchObject({
					channel: { revision: 1, archivedAt },
					latestSequence: 1,
					sidecar: { maintenance: true },
					updates: [],
					events: [],
				});
			} finally {
				await storage.close();
			}
		});

		it("replays only updates newer than the checkpoint", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 0,
					operationId: id("operation"),
					epoch: "epoch-1",
					update: new Uint8Array([1]),
					events: [],
					now: new Date("2026-01-04T03:04:05.000Z"),
				});
				let checkpoint = {
					channelId,
					lease,
					expectedRevision: 1,
					generation: id("generation"),
					revision: 1,
					throughSequence: 1,
					epoch: "epoch-1",
					source: "# Plan\n",
					sourceHash: "hash-1",
					document: new Uint8Array([2, 3]),
					sidecar: { questions: [] },
					createdAt: new Date("2026-01-04T03:05:05.000Z"),
				};
				try {
					await storage.collaboration.checkpoint({ ...checkpoint, throughSequence: 2 });
					expect.unreachable();
				} catch (err) {
					expect(err).toBeInstanceOf(StorageError);
					expect((err as StorageError).failure).toBe("conflict");
				}
				await storage.collaboration.checkpoint(checkpoint);

				let stored = await storage.collaboration.load(
					channelId,
					new Date("2026-01-04T03:05:05.000Z"),
				);
				expect(stored!.updates).toEqual([]);
				expect(stored!.latestSequence).toBe(1);
				expect([...stored!.snapshot!.document]).toEqual([2, 3]);
				expect(stored!.snapshot!.source).toBe("# Plan\n");

				let next = await storage.collaboration.commit({
					channelId,
					lease,
					expectedRevision: 1,
					operationId: id("operation"),
					epoch: "epoch-1",
					update: new Uint8Array([4]),
					events: [],
					now: new Date("2026-01-04T03:06:05.000Z"),
				});
				expect(next.sequence).toBe(2);
				expect((await storage.collaboration.load(channelId, new Date()))!.latestSequence).toBe(2);
			} finally {
				await storage.close();
			}
		});

		it("replaces an epoch and its sidecar atomically", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let input = {
					channelId,
					lease,
					expectedRevision: 0,
					operationId: id("replacement"),
					generation: id("generation"),
					epoch: "epoch-2",
					source: "# Replacement\n",
					sourceHash: "sha256:replacement",
					document: new Uint8Array([7, 8, 9]),
					sidecar: { version: 1, revision: 4 },
					now: new Date("2026-01-05T03:04:05.000Z"),
				};
				expect(await storage.collaboration.replace(input)).toEqual({
					revision: 1,
					sequence: 1,
					repeated: false,
				});
				let stored = await storage.collaboration.load(channelId, input.now);
				expect(stored!.snapshot).toMatchObject({ epoch: "epoch-2", throughSequence: 1 });
				expect([...stored!.snapshot!.document]).toEqual([7, 8, 9]);
				expect(stored!.sidecar).toEqual(input.sidecar);
				expect(stored!.updates).toEqual([]);
				expect(await storage.collaboration.replace(input)).toMatchObject({ repeated: true });
			} finally {
				await storage.close();
			}
		});

		it("creates channel-scoped research drafts idempotently and lists recent updates", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let input = researchWorkspace(channelId, userId, lease, {
					idempotencyKey: id("stable-create"),
					fingerprint: "sha256:create-research",
					origin: "planner",
					originMessageId: id("origin-message"),
				});
				await expect(storage.research.create({
					...input,
					id: id("missing-parent-workspace"),
					channelId: id("missing-channel"),
					idempotencyKey: id("missing-parent-request"),
				})).rejects.toMatchObject({ failure: "missing" });

				let first = await storage.research.create(input);
				expect(first).toMatchObject({
					repeated: false,
					workspace: {
						id: input.id,
						channelId,
						confirmedQuery: undefined,
						revision: 0,
						origin: "planner",
					},
				});
				let repeated = await storage.research.create({
					...input,
					id: id("ignored-workspace-id"),
					title: "Ignored retry title",
				});
				expect(repeated).toEqual({ workspace: first.workspace, repeated: true });
				await expect(storage.research.create({
					...input,
					id: id("conflicting-workspace"),
					fingerprint: "sha256:changed",
				})).rejects.toMatchObject({ failure: "conflict" });

				let newer = await storage.research.create(researchWorkspace(channelId, userId, lease, {
					title: "Recent research",
					now: new Date(input.now.getTime() + 1_000),
				}));
				expect((await storage.research.list(channelId, 1)).map(value => value.id))
					.toEqual([newer.workspace.id]);
				expect(await storage.research.get(id("other-channel"), input.id)).toBeUndefined();
				first.workspace.createdAt.setUTCFullYear(1999);
				expect((await storage.research.get(channelId, input.id))!.workspace.createdAt)
					.toEqual(input.now);

				expect(await storage.leases.release(lease)).toBe(true);
				await expect(storage.research.create(researchWorkspace(channelId, userId, lease)))
					.rejects.toMatchObject({ failure: "conflict" });
			} finally {
				await storage.close();
			}
		});

		it("lists repository research in channel order with grouped bounded workspaces", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, repositoryId, lease } = await userAndChannel(storage);
				let suffix = crypto.randomUUID();
				let channelA = `repository-channel-a-${suffix}`;
				let channelB = `repository-channel-b-${suffix}`;
				let emptyChannel = `repository-channel-0-empty-${suffix}`;
				let foreignChannel = `repository-channel-foreign-${suffix}`;
				let common = {
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					createdBy: userId,
				};
				await storage.channels.create({
					...common,
					id: emptyChannel,
					title: `Empty research parent ${suffix}`,
					now: new Date("2026-01-09T03:04:05.000Z"),
				});
				for (let [id, title] of [[channelB, "B"], [channelA, "A"]] as const) {
					await storage.channels.create({
						...common,
						id,
						title: `Research parent ${title} ${suffix}`,
						now: new Date("2026-01-08T03:04:05.000Z"),
					});
				}
				await storage.channels.create({
					...common,
					id: foreignChannel,
					repositoryId: `foreign-${repositoryId}`,
					repositoryName: "other",
					title: `Foreign research parent ${suffix}`,
					now: new Date("2026-01-10T03:04:05.000Z"),
				});

				let create = async (parentId: string, workspaceId: string, now: Date) =>
					storage.research.create(researchWorkspace(parentId, userId, lease, {
						id: workspaceId,
						title: workspaceId,
						idempotencyKey: `create-${workspaceId}`,
						fingerprint: `fingerprint-${workspaceId}`,
						now,
					}));
				let newest = `workspace-newest-${suffix}`;
				let tiedA = `workspace-tied-a-${suffix}`;
				let tiedB = `workspace-tied-b-${suffix}`;
				await create(channelA, tiedB, new Date("2026-01-11T03:04:05.000Z"));
				await create(channelA, tiedA, new Date("2026-01-11T03:04:05.000Z"));
				await create(channelA, newest, new Date("2026-01-12T03:04:05.000Z"));
				let channelBWorkspace = `workspace-channel-b-${suffix}`;
				let oldChannelWorkspace = `workspace-old-channel-${suffix}`;
				await create(channelB, channelBWorkspace, new Date("2026-01-13T03:04:05.000Z"));
				await create(channelId, oldChannelWorkspace, new Date("2026-01-14T03:04:05.000Z"));
				await create(
					foreignChannel,
					`workspace-foreign-${suffix}`,
					new Date("2026-01-15T03:04:05.000Z"),
				);

				let listed = await storage.research.listRepository(repositoryId, 10);
				expect(listed.truncated).toBe(false);
				expect(listed.channels.map(group => group.channel.id)).toEqual([
					channelA,
					channelB,
					channelId,
				]);
				expect(listed.channels[0]!.workspaces.map(value => value.id)).toEqual([
					newest,
					tiedA,
					tiedB,
				]);
				expect(listed.channels[1]!.workspaces.map(value => value.id))
					.toEqual([channelBWorkspace]);
				expect(listed.channels[2]!.workspaces.map(value => value.id))
					.toEqual([oldChannelWorkspace]);
				await storage.channels.archive({
					id: channelB,
					now: new Date("2026-01-16T03:04:05.000Z"),
				});
				expect(
					(await storage.research.listRepository(repositoryId, 10)).channels
						.map(group => group.channel.id),
				).toEqual([channelA, channelId]);
				expect(
					(await storage.research.listRepository(repositoryId, 10, true)).channels
						.map(group => group.channel.id),
				).toEqual([channelA, channelB, channelId]);
				expect((await storage.research.list(channelB, 10)).map(value => value.id))
					.toEqual([channelBWorkspace]);
				expect(await storage.research.get(channelB, channelBWorkspace)).toBeDefined();
				await storage.channels.restore({
					id: channelB,
					now: new Date("2026-01-16T03:04:06.000Z"),
				});

				let bounded = await storage.research.listRepository(repositoryId, 2);
				expect(bounded.truncated).toBe(true);
				expect(bounded.channels.map(group => ({
					channelId: group.channel.id,
					workspaceIds: group.workspaces.map(value => value.id),
				}))).toEqual([{ channelId: channelA, workspaceIds: [newest, tiedA] }]);

				for (let index = 0; index < 98; index++) {
					let workspaceId = `workspace-bounded-${String(index).padStart(3, "0")}-${suffix}`;
					await create(
						channelA,
						workspaceId,
						new Date(`2026-01-10T03:${String(index % 60).padStart(2, "0")}:00.000Z`),
					);
				}
				let perChannelBounded = await storage.research.listRepository(repositoryId, 500);
				expect(perChannelBounded.truncated).toBe(true);
				expect(perChannelBounded.channels[0]).toMatchObject({
					channel: { id: channelA },
				});
				expect(perChannelBounded.channels[0]!.workspaces).toHaveLength(100);
			} finally {
				await storage.close();
			}
		});

		it("confirms research and appends ordered turn-message pairs exactly once", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let draft = await storage.research.create(researchWorkspace(channelId, userId, lease));
				let followUp = {
					channelId,
					workspaceId: draft.workspace.id,
					turnId: id("follow-up-turn"),
					messageId: id("follow-up-message"),
					kind: "follow-up" as const,
					requestId: id("follow-up-request"),
					fingerprint: "sha256:follow-up",
					question: "What changed for existing clients?",
					requestedBy: userId,
					requestedByHandle: "octocat",
					now: new Date("2026-01-07T03:06:05.000Z"),
					lease,
				};
				await expect(storage.research.appendTurn(followUp))
					.rejects.toMatchObject({ failure: "conflict" });

				let confirmation = {
					channelId,
					workspaceId: draft.workspace.id,
					turnId: id("initial-turn"),
					messageId: id("initial-message"),
					requestId: id("confirmation-request"),
					fingerprint: "sha256:confirmation",
					confirmedQuery: "Which API contracts changed in version 3?",
					confirmedBy: userId,
					confirmedByHandle: "octocat",
					now: new Date("2026-01-07T03:05:05.000Z"),
					lease,
				};
				let confirmed = await storage.research.confirm(confirmation);
				expect(confirmed).toMatchObject({
					repeated: false,
					workspace: { revision: 1, confirmedQuery: confirmation.confirmedQuery },
					turn: { ordinal: 1, kind: "initial", question: confirmation.confirmedQuery },
					message: { sequence: 1, authorKind: "member", text: confirmation.confirmedQuery },
				});
				let confirmationReplay = await storage.research.confirm({
					...confirmation,
					turnId: id("ignored-turn"),
					messageId: id("ignored-message"),
					now: new Date(confirmation.now.getTime() + 1),
				});
				expect(confirmationReplay).toEqual({ ...confirmed, repeated: true });
				await expect(storage.research.confirm({
					...confirmation,
					requestId: id("second-confirmation"),
					fingerprint: "sha256:second-confirmation",
				})).rejects.toMatchObject({ failure: "conflict" });

				let appended = await storage.research.appendTurn(followUp);
				expect(appended).toMatchObject({
					workspace: { revision: 2 },
					turn: { ordinal: 2, kind: "follow-up" },
					message: { sequence: 2, authorKind: "member" },
				});
				let appendReplay = await storage.research.appendTurn({
					...followUp,
					turnId: id("ignored-follow-up-turn"),
					messageId: id("ignored-follow-up-message"),
					now: new Date(followUp.now.getTime() + 1),
				});
				expect(appendReplay).toEqual({ ...appended, repeated: true });
				await expect(storage.research.appendTurn({
					...followUp,
					fingerprint: "sha256:changed-follow-up",
				})).rejects.toMatchObject({ failure: "conflict" });

				let searchMore = {
					...followUp,
					turnId: id("search-more-turn"),
					messageId: id("search-more-message"),
					kind: "search-more" as const,
					requestId: id("search-more-request"),
					fingerprint: "sha256:search-more",
					question: "Search for more migration reports.",
					now: new Date(followUp.now.getTime() + 1_000),
				};
				let parallelFollowUp = {
					...followUp,
					turnId: id("parallel-turn"),
					messageId: id("parallel-message"),
					requestId: id("parallel-request"),
					fingerprint: "sha256:parallel-follow-up",
					question: "Which clients were tested?",
					now: new Date(followUp.now.getTime() + 1_001),
				};
				let parallel = await Promise.all([
					storage.research.appendTurn(searchMore),
					storage.research.appendTurn(parallelFollowUp),
				]);
				expect(parallel.map(value => value.turn.ordinal).sort()).toEqual([3, 4]);
				expect(parallel.map(value => value.message.sequence).sort()).toEqual([3, 4]);
				let detail = await storage.research.get(channelId, draft.workspace.id);
				expect(detail!.turns.map(value => value.ordinal)).toEqual([1, 2, 3, 4]);
				expect(detail!.messages.map(value => value.sequence)).toEqual([1, 2, 3, 4]);
				detail!.turns[0]!.createdAt.setUTCFullYear(1999);
				expect((await storage.research.get(channelId, draft.workspace.id))!.turns[0]!.createdAt)
					.toEqual(confirmation.now);
			} finally {
				await storage.close();
			}
		});

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

		it("preserves title and slug collision contracts during research publication", async () => {
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
				await expect(storage.research.publishInitialReport({
					channelId,
					workspaceId: collision.workspaceId,
					answerJobId: collision.answerJobId,
					title: "api COMPATIBILITY report",
					initial: collision.initial,
					now: new Date("2026-01-07T03:07:05.000Z"),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				expect(
					(await storage.research.get(channelId, collision.workspaceId))!.workspace
						.publishedChannelId,
				).toBeUndefined();
				expect(
					await storage.channels.get(
						deterministicChannelId(repositoryId, collision.workspaceId),
					),
				).toBeUndefined();

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

		it("rejects new archived research mutations but preserves exact replays", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let create = researchWorkspace(channelId, userId, lease, {
					id: id("archive-replay-workspace"),
					idempotencyKey: id("archive-replay-create"),
					fingerprint: "sha256:archive-replay-create",
				});
				let created = await storage.research.create(create);
				let unconfirmed = await storage.research.create(researchWorkspace(
					channelId,
					userId,
					lease,
					{
						id: id("archive-unconfirmed-workspace"),
						idempotencyKey: id("archive-unconfirmed-create"),
						fingerprint: "sha256:archive-unconfirmed-create",
					},
				));
				let confirmation = {
					channelId,
					workspaceId: created.workspace.id,
					turnId: id("archive-initial-turn"),
					messageId: id("archive-initial-message"),
					requestId: id("archive-confirmation"),
					fingerprint: "sha256:archive-confirmation",
					confirmedQuery: "Which archive fences are durable?",
					confirmedBy: userId,
					confirmedByHandle: "octocat",
					now: new Date("2026-01-07T03:05:05.000Z"),
					lease,
				};
				let confirmed = await storage.research.confirm(confirmation);
				let append = {
					channelId,
					workspaceId: created.workspace.id,
					turnId: id("archive-follow-up-turn"),
					messageId: id("archive-follow-up-message"),
					kind: "follow-up" as const,
					requestId: id("archive-follow-up"),
					fingerprint: "sha256:archive-follow-up",
					question: "Do exact retries remain available?",
					requestedBy: userId,
					requestedByHandle: "octocat",
					now: new Date("2026-01-07T03:06:05.000Z"),
					lease,
				};
				let appended = await storage.research.appendTurn(append);
				await storage.channels.archive({
					id: channelId,
					now: new Date("2026-01-08T03:04:05.000Z"),
				});

				expect(await storage.research.create(create)).toMatchObject({
					repeated: true,
					workspace: { id: created.workspace.id },
				});
				expect(await storage.research.confirm(confirmation)).toMatchObject({
					repeated: true,
					turn: { id: confirmed.turn.id },
					message: { id: confirmed.message.id },
				});
				expect(await storage.research.appendTurn(append)).toMatchObject({
					repeated: true,
					turn: { id: appended.turn.id },
					message: { id: appended.message.id },
				});

				await expect(storage.research.create(researchWorkspace(
					channelId,
					userId,
					lease,
					{
						id: id("archived-new-workspace"),
						idempotencyKey: id("archived-new-create"),
						fingerprint: "sha256:archived-new-create",
					},
				))).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.research.confirm({
					...confirmation,
					workspaceId: unconfirmed.workspace.id,
					turnId: id("archived-new-initial-turn"),
					messageId: id("archived-new-initial-message"),
					requestId: id("archived-new-confirmation"),
					fingerprint: "sha256:archived-new-confirmation",
				})).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.research.appendTurn({
					...append,
					turnId: id("archived-new-follow-up-turn"),
					messageId: id("archived-new-follow-up-message"),
					requestId: id("archived-new-follow-up"),
					fingerprint: "sha256:archived-new-follow-up",
					question: "This new request must be fenced.",
				})).rejects.toMatchObject({ failure: "conflict" });

				expect((await storage.research.get(channelId, created.workspace.id))!.turns)
					.toHaveLength(2);
				expect(
					(await storage.research.get(channelId, unconfirmed.workspace.id))!.workspace
						.confirmedQuery,
				).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		it("links channel jobs once and appends answer messages idempotently", async () => {
			let storage = await opened(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let draft = await storage.research.create(researchWorkspace(channelId, userId, lease));
				let confirmed = await storage.research.confirm({
					channelId,
					workspaceId: draft.workspace.id,
					turnId: id("initial-turn"),
					messageId: id("initial-message"),
					requestId: id("confirmation-request"),
					fingerprint: "sha256:confirmation",
					confirmedQuery: "What changed?",
					confirmedBy: userId,
					now: new Date("2026-01-07T03:05:05.000Z"),
					lease,
				});
				let evidence = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					type: "research-evidence",
					targetKey:
						`research-evidence:workspace:${draft.workspace.id}:turn:${confirmed.turn.id}:evidence`,
				}));
				let answer = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					type: "research-answer",
					targetKey:
						`research-answer:workspace:${draft.workspace.id}:turn:${confirmed.turn.id}:answer`,
				}));
				let otherChannel = id("other-channel");
				await storage.channels.create({
					id: otherChannel,
					repositoryId: id("other-repository"),
					repositoryOwner: "octo-org",
					repositoryName: "other",
					title: "Other research parent",
					createdBy: userId,
					now: new Date("2026-01-07T03:05:05.000Z"),
				});
				let foreign = await storage.jobs.enqueue(backgroundJob(otherChannel, lease, {
					type: "research-answer",
					targetKey: id("foreign-target"),
				}));
				let linkBase = {
					channelId,
					workspaceId: draft.workspace.id,
					turnId: confirmed.turn.id,
					now: new Date("2026-01-07T03:06:05.000Z"),
					lease,
				};
				await expect(storage.research.linkJob({
					...linkBase,
					role: "answer",
					jobId: foreign.job.id,
				})).rejects.toMatchObject({ failure: "missing" });

				let evidenceLink = await storage.research.linkJob({
					...linkBase,
					role: "evidence",
					jobId: evidence.job.id,
				});
				expect(evidenceLink).toMatchObject({
					repeated: false,
					workspace: { revision: 2 },
					turn: { evidenceJobId: evidence.job.id },
				});
				expect(
					await storage.research.linkJob({
						...linkBase,
						role: "evidence",
						jobId: evidence.job.id,
					}),
				).toEqual({ ...evidenceLink, repeated: true });
				await expect(storage.research.linkJob({
					...linkBase,
					role: "evidence",
					jobId: answer.job.id,
				})).rejects.toMatchObject({ failure: "conflict" });
				let answerLink = await storage.research.linkJob({
					...linkBase,
					role: "answer",
					jobId: answer.job.id,
					now: new Date(linkBase.now.getTime() + 1),
				});
				expect(answerLink.workspace.revision).toBe(3);
				expect((await storage.research.findTurnByJob(channelId, evidence.job.id))?.id)
					.toBe(confirmed.turn.id);
				expect((await storage.research.findTurnByJob(channelId, answer.job.id))?.id)
					.toBe(confirmed.turn.id);
				expect(await storage.research.findTurnByJob(otherChannel, answer.job.id)).toBeUndefined();

				let agentMessage = {
					channelId,
					workspaceId: draft.workspace.id,
					id: id("agent-message"),
					turnId: confirmed.turn.id,
					userHandle: "chopin",
					text: "The API retained wire compatibility.",
					sourceJobId: answer.job.id,
					now: new Date("2026-01-07T03:07:05.000Z"),
					lease,
				};
				await expect(storage.research.appendAgentMessage({
					...agentMessage,
					id: id("wrong-source-message"),
					sourceJobId: evidence.job.id,
				})).rejects.toMatchObject({ failure: "conflict" });
				let appended = await storage.research.appendAgentMessage(agentMessage);
				expect(appended).toMatchObject({
					repeated: false,
					workspace: { revision: 4 },
					message: {
						sequence: 2,
						authorKind: "agent",
						sourceJobId: answer.job.id,
					},
				});
				expect(
					await storage.research.appendAgentMessage({
						...agentMessage,
						id: id("replayed-agent-message"),
						now: new Date(agentMessage.now.getTime() + 1),
					}),
				).toEqual({ ...appended, repeated: true });
				await expect(storage.research.appendAgentMessage({
					...agentMessage,
					text: "Changed retry payload",
				})).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.get(channelId, answer.job.id))!.job.state).toBe("pending");
				expect((await storage.research.get(channelId, draft.workspace.id))!.messages)
					.toHaveLength(2);
			} finally {
				await storage.close();
			}
		});

		it("enqueues background targets idempotently without collaboration side effects", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let beforeChannel = await storage.channels.get(channelId);
				let beforeCollaboration = await storage.collaboration.load(channelId, new Date());
				expect(await storage.jobs.list(channelId, 20)).toEqual({ revision: 0, jobs: [] });
				await expect(storage.jobs.enqueue(backgroundJob(channelId, lease, { id: "" })))
					.rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.list(channelId, 20))!.revision).toBe(0);

				let input = backgroundJob(channelId, lease, {
					id: id("first-job"),
					idempotencyKey: id("first-enqueue"),
					fingerprint: "sha256:first",
					input: { revision: 1, nested: ["source"] },
				});
				let first = await storage.jobs.enqueue(input);
				expect(first.repeated).toBe(false);
				expect(first.job).toMatchObject({
					state: "pending",
					targetGeneration: 1,
					revision: 1,
				});
				let repeated = await storage.jobs.enqueue({ ...input, id: id("ignored-job") });
				expect(repeated).toEqual({ job: first.job, repeated: true });
				expect((await storage.jobs.list(channelId, 20))!.revision).toBe(1);
				await expect(storage.jobs.enqueue({
					...input,
					id: id("conflicting-job"),
					fingerprint: "sha256:changed",
				})).rejects.toMatchObject({ failure: "conflict" });

				let second = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					fingerprint: "sha256:second",
					type: "research-answer",
					input: { revision: 2, question: "Which clients were tested?" },
					now: new Date(input.now.getTime() + 1),
				}));
				expect(second.job).toMatchObject({ targetGeneration: 2, revision: 2 });
				expect((await storage.jobs.get(channelId, first.job.id))!.job.state).toBe("superseded");
				let independent = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
					targetKey: "research:evidence-1",
					type: "research-evidence",
					origin: "user",
					input: { query: "What changed in the API?" },
					now: new Date(input.now.getTime() + 2),
				}));
				expect(independent.job).toMatchObject({ targetGeneration: 1, revision: 3 });
				let page = await storage.jobs.list(channelId, 2);
				expect(page!.jobs.map(job => job.id)).toEqual([independent.job.id, second.job.id]);
				expect(page!.jobs.map(job => job.subject)).toEqual([
					"What changed in the API?",
					"Which clients were tested?",
				]);
				expect(page!.next).toBeDefined();
				expect("input" in page!.jobs[0]!).toBe(false);
				let remainder = await storage.jobs.list(channelId, 2, page!.next);
				expect(remainder!.jobs.map(job => job.id)).toEqual([first.job.id]);

				let detail = await storage.jobs.get(channelId, second.job.id);
				(detail!.job.input as { revision: number }).revision = 99;
				expect((await storage.jobs.get(channelId, second.job.id))!.job.input)
					.toEqual({ question: "Which clients were tested?", revision: 2 });
				expect(await storage.channels.get(channelId)).toEqual(beforeChannel);
				expect(await storage.collaboration.load(channelId, new Date())).toEqual(
					beforeCollaboration,
				);
			} finally {
				await storage.close();
			}
		});

		it("requires an archive allowance to cancel background work", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let now = new Date("2026-01-07T03:04:05.000Z");
				let queued = await storage.jobs.enqueue(backgroundJob(channelId, lease, { now }));
				await storage.channels.archive({
					id: channelId,
					now: new Date(now.getTime() + 1),
				});

				let cancellation = {
					channelId,
					jobId: queued.job.id,
					now: new Date(now.getTime() + 2),
					lease,
				};
				await expect(storage.jobs.cancel(cancellation))
					.rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.get(channelId, queued.job.id))!.job.state).toBe("pending");

				let cancelled = await storage.jobs.cancel({ ...cancellation, allowArchived: true });
				expect(cancelled.state).toBe("cancelled");
			} finally {
				await storage.close();
			}
		});

		it("fences claims and publishes a background artifact atomically", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let now = new Date();
				let queued = (await storage.jobs.enqueue(backgroundJob(channelId, lease, { now }))).job;
				let [claimed] = await storage.jobs.claim({
					channelId,
					claimOwner: "worker-1",
					count: 1,
					ttlMs: 10_000,
					now: new Date(now.getTime() + 1),
					lease,
				});
				expect(claimed).toMatchObject({
					id: queued.id,
					state: "running",
					attempts: 1,
					claimGeneration: 1,
					revision: 2,
				});
				let renewed = await storage.jobs.renew({
					channelId,
					jobId: claimed!.id,
					claimOwner: "worker-1",
					claimGeneration: claimed!.claimGeneration,
					expectedRevision: claimed!.revision,
					claimBinding: { ownerSessionId: "session-1", ownerGeneration: 3 },
					ttlMs: 10_000,
					now: new Date(now.getTime() + 2),
					lease,
				});
				expect(renewed).toMatchObject({
					revision: 3,
					claimBinding: { ownerSessionId: "session-1" },
				});
				await expect(storage.jobs.renew({
					channelId,
					jobId: claimed!.id,
					claimOwner: "worker-1",
					claimGeneration: claimed!.claimGeneration,
					expectedRevision: claimed!.revision,
					claimBinding: { ownerSessionId: "stale-session" },
					ttlMs: 20_000,
					now: new Date(now.getTime() + 3),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				await expect(storage.jobs.settle({
					channelId,
					jobId: claimed!.id,
					claimOwner: "worker-1",
					claimGeneration: claimed!.claimGeneration + 1,
					artifact: { abstract: "wrong" },
					now: new Date(now.getTime() + 3),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.get(channelId, claimed!.id))!.artifact).toBeUndefined();

				let requeued = await storage.jobs.requeue({
					channelId,
					jobId: claimed!.id,
					claimOwner: "worker-1",
					claimGeneration: claimed!.claimGeneration,
					availableAt: new Date(now.getTime() + 4),
					reason: "retry",
					countFailure: true,
					now: new Date(now.getTime() + 3),
					lease,
				});
				expect(requeued).toMatchObject({
					state: "pending",
					revision: 4,
					reason: "retry",
					failures: 1,
				});
				let [secondClaim] = await storage.jobs.claim({
					channelId,
					claimOwner: "worker-2",
					count: 1,
					ttlMs: 10_000,
					now: new Date(now.getTime() + 5),
					lease,
				});
				expect(secondClaim).toMatchObject({ attempts: 2, claimGeneration: 2, revision: 5 });
				let paused = await storage.jobs.pause({
					channelId,
					jobId: secondClaim!.id,
					expectedRevision: secondClaim!.revision,
					reason: "owner-unavailable",
					now: new Date(now.getTime() + 6),
					lease,
				});
				expect(paused).toMatchObject({ state: "paused", revision: 6 });
				await expect(storage.jobs.fail({
					channelId,
					jobId: secondClaim!.id,
					claimOwner: "worker-2",
					claimGeneration: secondClaim!.claimGeneration,
					reason: "late",
					now: new Date(now.getTime() + 7),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				let resumed = await storage.jobs.resume({
					channelId,
					jobId: paused.id,
					expectedRevision: paused.revision,
					availableAt: new Date(now.getTime() + 8),
					now: new Date(now.getTime() + 8),
					lease,
				});
				expect(resumed).toMatchObject({ state: "pending", revision: 7 });
				let [finalClaim] = await storage.jobs.claim({
					channelId,
					claimOwner: "worker-3",
					count: 1,
					ttlMs: 10_000,
					now: new Date(now.getTime() + 9),
					lease,
				});
				let completed = await storage.jobs.settle({
					channelId,
					jobId: finalClaim!.id,
					claimOwner: "worker-3",
					claimGeneration: finalClaim!.claimGeneration,
					artifact: { abstract: "Current summary", sources: [] },
					now: new Date(now.getTime() + 10),
					lease,
				});
				expect(completed.job).toMatchObject({ state: "completed", revision: 9 });
				expect(completed.artifact).toMatchObject({
					revision: 9,
					value: { abstract: "Current summary", sources: [] },
				});
				(completed.artifact!.value as { abstract: string }).abstract = "mutated";
				expect((await storage.jobs.get(channelId, completed.job.id))!.artifact!.value)
					.toMatchObject({ abstract: "Current summary" });
				await expect(storage.jobs.cancel({
					channelId,
					jobId: completed.job.id,
					now: new Date(now.getTime() + 11),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
			} finally {
				await storage.close();
			}
		});

		it("reclaims expired background claims and rejects a fenced writer", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let now = new Date();
				let queued = (await storage.jobs.enqueue(backgroundJob(channelId, lease, { now }))).job;
				let [first] = await storage.jobs.claim({
					channelId,
					claimOwner: "old-worker",
					count: 1,
					ttlMs: 1,
					now,
					lease,
				});
				let [replacement] = await storage.jobs.claim({
					channelId,
					claimOwner: "new-worker",
					count: 1,
					ttlMs: 10_000,
					now: new Date(now.getTime() + 2),
					lease,
				});
				expect(replacement).toMatchObject({
					id: queued.id,
					attempts: 2,
					claimGeneration: 2,
				});
				await expect(storage.jobs.fail({
					channelId,
					jobId: queued.id,
					claimOwner: "old-worker",
					claimGeneration: first!.claimGeneration,
					reason: "stale",
					now: new Date(now.getTime() + 3),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				let failed = await storage.jobs.fail({
					channelId,
					jobId: queued.id,
					claimOwner: "new-worker",
					claimGeneration: replacement!.claimGeneration,
					reason: "attempts-exhausted",
					now: new Date(now.getTime() + 4),
					lease,
				});
				expect(failed.state).toBe("failed");

				expect(await storage.leases.release(lease)).toBe(true);
				let nextLease = await storage.leases.acquire(lease.name, "replacement", 60_000);
				expect(nextLease).toBeDefined();
				await expect(storage.jobs.enqueue(backgroundJob(channelId, lease)))
					.rejects.toMatchObject({ failure: "conflict" });
			} finally {
				await storage.close();
			}
		});

		it("persists bounded progress only for the active background claim", async () => {
			let storage = await opened(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let now = new Date("2026-01-06T03:04:05.000Z");
				let queued = (await storage.jobs.enqueue(backgroundJob(channelId, lease, { now }))).job;
				let [firstClaim] = await storage.jobs.claim({
					channelId,
					claimOwner: "progress-worker-1",
					count: 1,
					ttlMs: 60_000,
					now: new Date(now.getTime() + 1),
					lease,
				});
				expect(firstClaim!.progress).toEqual([]);
				let beforeInvalid = (await storage.jobs.list(channelId, 10))!.revision;
				await expect(storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration,
					stage: "invalid stage",
					label: "Invalid",
					state: "started",
					now: new Date(now.getTime() + 2),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.list(channelId, 10))!.revision).toBe(beforeInvalid);
				await expect(storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration,
					stage: "public-web",
					label: "Public web research",
					state: "interrupted",
					now: new Date(now.getTime() + 2),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				expect((await storage.jobs.list(channelId, 10))!.revision).toBe(beforeInvalid);
				await expect(storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration + 1,
					stage: "public-web",
					label: "Public web research",
					state: "started",
					now: new Date(now.getTime() + 2),
					lease,
				})).rejects.toMatchObject({ failure: "conflict" });
				let firstProgress = await storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration,
					stage: "public-web",
					label: "Public web research",
					state: "started",
					now: new Date(now.getTime() + 2),
					lease,
				});
				expect(firstProgress.progress).toMatchObject([{
					attempt: 1,
					stage: "public-web",
					label: "Public web research",
					state: "started",
				}]);
				let interrupted = await storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration,
					stage: "public-web",
					label: "Public web research",
					state: "interrupted",
					reason: "attempt-error",
					now: new Date(now.getTime() + 3),
					lease,
				});
				expect(interrupted.progress.at(-1)).toMatchObject({
					state: "interrupted",
					reason: "attempt-error",
				});
				await storage.jobs.requeue({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-1",
					claimGeneration: firstClaim!.claimGeneration,
					availableAt: new Date(now.getTime() + 3),
					reason: "retry",
					countFailure: true,
					now: new Date(now.getTime() + 4),
					lease,
				});
				let [secondClaim] = await storage.jobs.claim({
					channelId,
					claimOwner: "progress-worker-2",
					count: 1,
					ttlMs: 60_000,
					now: new Date(now.getTime() + 5),
					lease,
				});
				let current = await storage.jobs.appendProgress({
					channelId,
					jobId: queued.id,
					claimOwner: "progress-worker-2",
					claimGeneration: secondClaim!.claimGeneration,
					stage: "public-web",
					label: "Public web research",
					state: "started",
					now: new Date(now.getTime() + 6),
					lease,
				});
				expect(current.progress.map(entry => entry.attempt)).toEqual([1, 1, 2]);
				for (let index = 0; index < BACKGROUND_JOB_PROGRESS_LIMIT; index++) {
					current = await storage.jobs.appendProgress({
						channelId,
						jobId: queued.id,
						claimOwner: "progress-worker-2",
						claimGeneration: secondClaim!.claimGeneration,
						stage: `step-${index}`,
						label: `Progress step ${index}`,
						state: index % 2 === 0 ? "started" : "completed",
						now: new Date(now.getTime() + 7 + index),
						lease,
					});
				}
				expect(current.progress).toHaveLength(BACKGROUND_JOB_PROGRESS_LIMIT);
				expect(current.progress.at(-1)?.stage).toBe(`step-${BACKGROUND_JOB_PROGRESS_LIMIT - 1}`);
				let page = await storage.jobs.list(channelId, 10);
				expect(page!.jobs[0]!.progress).toEqual(current.progress);
				page!.jobs[0]!.progress[0]!.label = "mutated";
				expect((await storage.jobs.get(channelId, queued.id))!.job.progress[0]!.label)
					.not.toBe("mutated");
			} finally {
				await storage.close();
			}
		});

		it("fences competing lease owners", async () => {
			let storage = await opened(factory);
			try {
				let name = id("writer");
				let first = await storage.leases.acquire(name, "one", 30_000);
				expect(first).toBeDefined();
				expect(await storage.leases.acquire(name, "two", 30_000)).toBeUndefined();
				let renewed = await storage.leases.renew(first!, 30_000);
				expect(renewed!.fencing).toBe(first!.fencing);
				expect(await storage.leases.release(renewed!)).toBe(true);
				let second = await storage.leases.acquire(name, "two", 30_000);
				expect(second!.fencing).toBeGreaterThan(first!.fencing);
			} finally {
				await storage.close();
			}
		});

		it("refuses a commit from an expired lease holder", async () => {
			let storage = await opened(factory);
			try {
				let { channelId } = await userAndChannel(storage);
				let name = id("short-writer");
				let first = await storage.leases.acquire(name, "one", 5);
				expect(first).toBeDefined();
				await Bun.sleep(20);
				let second = await storage.leases.acquire(name, "two", 30_000);
				expect(second).toBeDefined();

				try {
					await storage.collaboration.commit({
						channelId,
						lease: first!,
						expectedRevision: 0,
						operationId: id("stale-writer"),
						epoch: "epoch-1",
						update: new Uint8Array([1]),
						events: [],
						now: new Date(),
					});
					expect.unreachable();
				} catch (err) {
					expect(err).toBeInstanceOf(StorageError);
					expect((err as StorageError).failure).toBe("conflict");
				}
			} finally {
				await storage.close();
			}
		});
	});
}
