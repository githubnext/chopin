import { describe, expect, it } from "bun:test";

import { StorageError } from "./errors";

import type { JsonValue, Lease } from "./model";
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
