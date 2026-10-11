import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";

import type { StorageFactory } from "./contract-support";
import type { JsonValue } from "./model";

function sidecar(transcript: JsonValue[], questions: JsonValue[] = []): JsonValue {
	return {
		version: 1,
		revision: 0,
		documentSeq: 0,
		questions,
		openQuestions: [],
		threads: [],
		transcript,
	};
}

function transcript(value: JsonValue | undefined): JsonValue {
	return (value as { transcript?: JsonValue } | undefined)?.transcript ?? null;
}

export function childChannelContract(name: string, factory: StorageFactory) {
	describe(`${name} child channels`, () => {
		test("lists only a parent's own unarchived children, oldest first and bounded", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, repositoryId } = await userAndChannel(storage);
				let fields = {
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					createdBy: userId,
				};
				let later = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Later ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T05:00:00.000Z"),
				});
				let earlier = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Earlier ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T04:00:00.000Z"),
				});
				let archived = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Archived ${id("c")}`,
					parentChannelId: channelId,
					now: new Date("2026-01-03T03:00:00.000Z"),
				});
				await storage.channels.archive({
					id: archived.id,
					now: new Date("2026-01-03T06:00:00.000Z"),
				});
				let otherRoot = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Other root ${id("c")}`,
					now: new Date("2026-01-03T03:30:00.000Z"),
				});
				await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Other child ${id("c")}`,
					parentChannelId: otherRoot.id,
					now: new Date("2026-01-03T03:40:00.000Z"),
				});

				let listed = await storage.channels.children(channelId, 10);
				expect(listed.map(child => child.id)).toEqual([earlier.id, later.id]);
				expect(listed.every(child => child.parentChannelId === channelId)).toBe(true);
				expect((await storage.channels.children(channelId, 1)).map(child => child.id))
					.toEqual([earlier.id]);
				expect(await storage.channels.children(earlier.id, 10)).toEqual([]);
				expect(await storage.channels.children(crypto.randomUUID(), 10)).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("clears child conversations once, under the lease, and never the root's", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, sessionId, channelId, repositoryId, lease } = await userAndChannel(
					storage,
				);
				let message = {
					id: crypto.randomUUID(),
					author: { kind: "member", handle: "ana" },
					text: "hi",
					ts: 1,
				};
				let initial = (value: JsonValue) => ({
					generation: id("generation"),
					epoch: id("epoch"),
					source: "# Child\n",
					sourceHash: "sha256:child",
					document: new Uint8Array([1, 2, 3]),
					sidecar: value,
				});
				let fields = {
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					createdBy: userId,
					now: new Date("2026-01-03T03:04:05.000Z"),
				};
				let chatty = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Chatty ${id("c")}`,
					parentChannelId: channelId,
					initial: initial({
						...sidecar([message]) as Record<string, JsonValue>,
						conversationPlan: { queue: [{ messageId: message.id }] },
					}),
				});
				let quiet = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Quiet ${id("c")}`,
					parentChannelId: channelId,
					initial: initial(sidecar([])),
				});
				let pinned = await storage.channels.create({
					...fields,
					id: crypto.randomUUID(),
					title: `Pinned ${id("c")}`,
					parentChannelId: channelId,
					initial: initial(sidecar([message], [{
						id: "q",
						optionOrigins: { o: { origin: "chat", source: { messageId: message.id } } },
					}])),
				});
				await storage.collaboration.checkpoint({
					channelId,
					lease,
					expectedRevision: 0,
					generation: id("generation"),
					revision: 0,
					throughSequence: 0,
					epoch: id("epoch"),
					source: "# Root\n",
					sourceHash: "sha256:root",
					document: new Uint8Array([4, 5, 6]),
					sidecar: sidecar([message]),
					createdAt: fields.now,
				});
				let claimed = await storage.channels.claimAgentOwner(chatty.id, sessionId, fields.now);
				await storage.channels.updateAgentContext({
					channelId: chatty.id,
					ownerSessionId: sessionId,
					generation: claimed.generation,
					summary: "They said hi.",
					transcriptCursor: 1,
					status: "ready",
					now: fields.now,
				});

				let first = await storage.collaboration.dropChildConversations(lease);
				expect(first.cleared).toContain(chatty.id);
				expect(first.cleared).not.toContain(quiet.id);
				expect(first.cleared).not.toContain(pinned.id);
				expect(first.cleared).not.toContain(channelId);
				expect(first.kept).toContain(pinned.id);
				expect(first.kept).not.toContain(channelId);
				let child = await storage.collaboration.load(chatty.id, fields.now);
				expect(child?.sidecar).toEqual(sidecar([]));
				expect(child?.snapshot?.sidecar).toEqual(sidecar([]));
				expect(child?.agent).toMatchObject({ summary: "", transcriptCursor: 0 });
				let root = await storage.collaboration.load(channelId, fields.now);
				expect(transcript(root?.snapshot?.sidecar)).toHaveLength(1);
				let kept = await storage.collaboration.load(pinned.id, fields.now);
				expect(transcript(kept?.sidecar)).toHaveLength(1);
				expect(transcript(kept?.snapshot?.sidecar)).toHaveLength(1);

				let second = await storage.collaboration.dropChildConversations(lease);
				expect(second.cleared).not.toContain(chatty.id);
				expect(second.kept).toContain(pinned.id);

				let stale = { ...lease, fencing: lease.fencing - 1 };
				await expect(storage.collaboration.dropChildConversations(stale)).rejects
					.toMatchObject({ failure: "conflict" });
			} finally {
				await storage.close();
			}
		});
	});
}
