import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { ChatSessionState, ChatThreadRecord } from "./model";

const AT = new Date("2026-01-03T03:04:05.000Z");

export function chatThreadContract(name: string, factory: StorageFactory) {
	describe(`${name} Chat threads and session state`, () => {
		test("stores, orders, updates and isolates threads and session fork state per document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				expect(await storage.chatThreads.listThreads(channelId)).toEqual([]);
				expect(await storage.chatThreads.getThread(channelId, "root-1")).toBeUndefined();
				expect(await storage.chatThreads.getSessionState(channelId)).toBeUndefined();

				let second: ChatThreadRecord = {
					channelId,
					rootId: "root-2",
					root: {
						id: "root-2",
						author: { kind: "agent" },
						text: "Second root",
						ts: 200,
					},
					forkedAt: 210,
					createdBy: "bob",
					entries: [
						{
							id: "reply-2a",
							author: { kind: "member", handle: "bob" },
							text: "Can you clarify?",
							ts: 215,
						},
					],
					compactions: [],
					forkState: {
						bootstrapEntries: [
							{
								id: "root-2",
								author: { kind: "agent" },
								text: "Second root",
								ts: 200,
							},
						],
						remoteFrom: { session: "remote-1", turn: "turn-2" },
					},
					updatedAt: AT,
				};

				let first: ChatThreadRecord = {
					channelId,
					rootId: "root-1",
					root: {
						id: "root-1",
						author: { kind: "member", handle: "ana" },
						text: "First root",
						ts: 100,
					},
					forkedAt: 120,
					createdBy: "ana",
					entries: [
						{
							id: "reply-1a",
							author: { kind: "member", handle: "ana" },
							text: "Side question",
							ts: 125,
							to: "planner",
							deliveryState: "delivered",
						},
						{
							id: "reply-1b",
							author: { kind: "agent" },
							text: "Side answer",
							ts: 130,
						},
					],
					compactions: [
						{
							id: "c-1",
							afterEntryId: "reply-1a",
							summary: "Earlier thread context summarized.",
							messagesSummarized: 4,
							tokensBefore: 24000,
							tokensAfter: 6000,
							trigger: "auto",
							ts: 128,
						},
					],
					usage: {
						system: 800,
						tools: 1200,
						messages: 4000,
						inputTokens: 5200,
						outputTokens: 800,
						totalTokens: 6000,
						contextWindow: 128000,
					},
					forkState: {
						bootstrapEntries: [
							{
								id: "root-1",
								author: { kind: "member", handle: "ana" },
								text: "First root",
								ts: 100,
							},
						],
						atomicEntries: [{ type: "session", id: "s1" }, { id: "leaf-1", type: "message" }],
						atomicLeafId: "leaf-1",
					},
					updatedAt: AT,
				};

				await storage.chatThreads.putThread(lease, second);
				await storage.chatThreads.putThread(lease, first);

				expect(await storage.chatThreads.getThread(channelId, "root-1")).toEqual(first);
				expect((await storage.chatThreads.listThreads(channelId)).map(item => item.rootId)).toEqual(
					["root-1", "root-2"],
				);

				let mutated = (await storage.chatThreads.getThread(channelId, "root-1"))!;
				mutated.entries.push({
					id: "unsaved",
					author: { kind: "system" },
					text: "mutated",
					ts: 999,
				});
				expect((await storage.chatThreads.getThread(channelId, "root-1"))!.entries).toHaveLength(2);

				let sessionState: ChatSessionState = {
					channelId,
					compactions: [
						{
							id: "top-c1",
							summary: "Summarized top-level chat.",
							messagesSummarized: 10,
							tokensBefore: 44541,
							tokensAfter: 11200,
							trigger: "manual",
							ts: 150,
						},
					],
					usage: {
						messages: 11200,
						inputTokens: 10000,
						outputTokens: 1200,
						totalTokens: 11200,
						contextWindow: 128000,
					},
					atomicEntries: [{ type: "session", id: "top-s" }],
					atomicLeafId: null,
					entryForks: {
						"root-1": { atomicLeafId: "leaf-1", remote: { session: "rs-1", turn: "rt-1" } },
					},
					updatedAt: AT,
				};
				await storage.chatThreads.putSessionState(lease, sessionState);
				expect(await storage.chatThreads.getSessionState(channelId)).toEqual(sessionState);
			} finally {
				await storage.close();
			}
		});

		test("refuses writes for missing documents or stale writer leases, and cascades on channel delete", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, lease } = await userAndChannel(storage);
				let record: ChatThreadRecord = {
					channelId,
					rootId: "root-1",
					root: { id: "root-1", author: { kind: "agent" }, text: "Hello", ts: 1 },
					forkedAt: 2,
					createdBy: "ana",
					entries: [],
					compactions: [],
					forkState: { bootstrapEntries: [] },
					updatedAt: AT,
				};
				let missingThread = await storage.chatThreads
					.putThread(lease, { ...record, channelId: id("missing-channel") })
					.then(() => undefined, err => err);
				expect(missingThread).toBeInstanceOf(StorageError);

				await storage.chatThreads.putThread(lease, record);
				await storage.chatThreads.putSessionState(lease, {
					channelId,
					compactions: [],
					entryForks: {},
					updatedAt: AT,
				});

				await storage.leases.release(lease);
				let stale = await storage.chatThreads
					.putThread(lease, { ...record, forkedAt: 99 })
					.then(() => undefined, err => err);
				expect(stale).toBeInstanceOf(StorageError);
				expect((await storage.chatThreads.getThread(channelId, "root-1"))!.forkedAt).toBe(2);

				await storage.channels.archive({ id: channelId, now: AT });
				await storage.channels.delete(channelId);
				expect(await storage.chatThreads.getThread(channelId, "root-1")).toBeUndefined();
				expect(await storage.chatThreads.listThreads(channelId)).toEqual([]);
				expect(await storage.chatThreads.getSessionState(channelId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});
	});
}
