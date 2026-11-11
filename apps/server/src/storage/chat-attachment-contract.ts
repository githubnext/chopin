import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";
import type { StorageAdapter } from "./port";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const NOW = new Date("2026-01-02T03:04:05.000Z");

function bytes(...extra: number[]): Uint8Array {
	return new Uint8Array([...PNG, ...extra]);
}

async function upload(
	storage: StorageAdapter,
	channelId: string,
	userId: string,
	overrides: {
		id?: string;
		name?: string;
		kind?: "image" | "file";
		mimeType?: string;
		bytes?: Uint8Array;
		now?: Date;
	} = {},
) {
	let attachment = {
		id: overrides.id ?? id("attachment"),
		channelId,
		name: overrides.name ?? "shot.png",
		kind: overrides.kind ?? "image" as const,
		mimeType: overrides.mimeType ?? "image/png",
		bytes: overrides.bytes ?? bytes(1, 2, 3),
		uploadedBy: userId,
		now: overrides.now ?? NOW,
	};
	await storage.chatAttachments.put(attachment);
	return attachment;
}

export function chatAttachmentContract(name: string, factory: StorageFactory) {
	describe(`${name} chat attachments`, () => {
		test("keeps an upload as its uploader's, with its bytes, and hands back copies", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let first = await upload(storage, channelId, userId);
				let stored = await storage.chatAttachments.get(channelId, first.id);
				expect(stored).toEqual({
					id: first.id,
					channelId,
					name: "shot.png",
					kind: "image",
					mimeType: "image/png",
					bytes: first.bytes,
					size: first.bytes.byteLength,
					uploadedBy: userId,
					createdAt: NOW,
				});
				stored!.bytes[0] = 0;
				expect((await storage.chatAttachments.get(channelId, first.id))?.bytes[0]).toBe(0x89);
				// An id belongs to its document alone.
				expect(await storage.chatAttachments.get(id("other-channel"), first.id)).toBeUndefined();
				expect(await storage.chatAttachments.get(channelId, id("missing"))).toBeUndefined();
				// Keeping the same upload again keeps the first.
				await storage.chatAttachments.put({
					...first,
					name: "renamed.png",
					bytes: bytes(9),
					now: new Date("2026-02-02T03:04:05.000Z"),
				});
				expect((await storage.chatAttachments.get(channelId, first.id))?.name).toBe("shot.png");
			} finally {
				await storage.close();
			}
		});

		test("keeps a text file under its text type and refuses a type the kind does not allow", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let notes = await upload(storage, channelId, userId, {
					name: "notes.md",
					kind: "file",
					mimeType: "text/plain",
					bytes: new TextEncoder().encode("# Notes\n"),
				});
				expect((await storage.chatAttachments.get(channelId, notes.id))?.mimeType).toBe(
					"text/plain",
				);
				for (
					let wrong of [{ kind: "file", mimeType: "text/html" }, {
						kind: "image",
						mimeType: "image/svg+xml",
					}] as const
				) {
					let failure = await upload(storage, channelId, userId, wrong).catch(error => error);
					expect(failure, `${wrong.kind} ${wrong.mimeType}`).toBeInstanceOf(Error);
				}
			} finally {
				await storage.close();
			}
		});

		test("refuses an upload for a missing document or user", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let ghostChannel = await upload(storage, id("ghost-channel"), userId).catch(error => error);
				expect(ghostChannel).toBeInstanceOf(StorageError);
				expect((ghostChannel as StorageError).failure).toBe("missing");
				let ghostUser = await upload(storage, channelId, id("ghost-user")).catch(error => error);
				expect(ghostUser).toBeInstanceOf(StorageError);
				expect((ghostUser as StorageError).failure).toBe("missing");
			} finally {
				await storage.close();
			}
		});

		test("counts what a person has uploaded and not sent, to bound what they can keep", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				expect(await storage.chatAttachments.staged(channelId, userId)).toEqual({
					count: 0,
					bytes: 0,
				});
				let one = await upload(storage, channelId, userId, { bytes: bytes(1) });
				let two = await upload(storage, channelId, userId, { bytes: bytes(1, 2) });
				expect(await storage.chatAttachments.staged(channelId, userId)).toEqual({
					count: 2,
					bytes: one.bytes.byteLength + two.bytes.byteLength,
				});
				expect(await storage.chatAttachments.staged(channelId, id("someone-else"))).toEqual({
					count: 0,
					bytes: 0,
				});
				let entryId = id("message");
				expect(
					await storage.chatAttachments.bind({ channelId, userId, ids: [one.id], entryId }),
				).toBe(true);
				expect(await storage.chatAttachments.staged(channelId, userId)).toEqual({
					count: 1,
					bytes: two.bytes.byteLength,
				});
			} finally {
				await storage.close();
			}
		});

		test("sends uploads with a message in the order given, all or none", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let a = await upload(storage, channelId, userId, { name: "a.png", bytes: bytes(1) });
				let b = await upload(storage, channelId, userId, { name: "b.png", bytes: bytes(2) });
				let c = await upload(storage, channelId, userId, { name: "c.png", bytes: bytes(3) });
				let entryId = id("message");

				expect(
					await storage.chatAttachments.bind({ channelId, userId, ids: [c.id, a.id], entryId }),
				).toBe(true);
				let sent = await storage.chatAttachments.forEntry(channelId, entryId);
				expect(sent.map(value => value.name)).toEqual(["c.png", "a.png"]);
				expect(sent.map(value => value.position)).toEqual([0, 1]);
				expect(sent.every(value => value.entryId === entryId)).toBe(true);

				// The same message again, in the same or another order, binds again: a retried send.
				expect(
					await storage.chatAttachments.bind({ channelId, userId, ids: [c.id, a.id], entryId }),
				).toBe(true);

				// One that is sent already, with another message, is a refusal that binds none.
				let other = id("other-message");
				expect(
					await storage.chatAttachments.bind({
						channelId,
						userId,
						ids: [b.id, a.id],
						entryId: other,
					}),
				).toBe(false);
				expect(await storage.chatAttachments.forEntry(channelId, other)).toEqual([]);
				expect((await storage.chatAttachments.get(channelId, b.id))?.entryId).toBeUndefined();

				// One that is missing, one repeated, and one from another document bind none.
				expect(
					await storage.chatAttachments.bind({
						channelId,
						userId,
						ids: [b.id, id("missing")],
						entryId: other,
					}),
				).toBe(false);
				expect(
					await storage.chatAttachments.bind({
						channelId,
						userId,
						ids: [b.id, b.id],
						entryId: other,
					}),
				).toBe(false);
				expect(
					await storage.chatAttachments.bind({
						channelId: id("elsewhere"),
						userId,
						ids: [b.id],
						entryId: other,
					}),
				).toBe(false);
				expect((await storage.chatAttachments.get(channelId, b.id))?.entryId).toBeUndefined();
				expect(
					await storage.chatAttachments.bind({
						channelId,
						userId,
						ids: [b.id, c.id],
						entryId: other,
					}),
				).toBe(false);
				expect((await storage.chatAttachments.get(channelId, b.id))?.entryId).toBeUndefined();

				expect(
					await storage.chatAttachments.bind({ channelId, userId, ids: [b.id], entryId: other }),
				).toBe(true);
			} finally {
				await storage.close();
			}
		});

		test("sends only what the sender uploaded", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let theirs = await upload(storage, channelId, userId);
				let stranger = id("stranger");
				await storage.users.put({
					id: stranger,
					login: "hubot",
					avatarUrl: "https://example.test/b",
					now: NOW,
				});
				expect(
					await storage.chatAttachments.bind({
						channelId,
						userId: stranger,
						ids: [theirs.id],
						entryId: id("message"),
					}),
				).toBe(false);
				expect(await storage.chatAttachments.discard(channelId, theirs.id, stranger)).toBe(false);
				expect(await storage.chatAttachments.get(channelId, theirs.id)).toBeDefined();
			} finally {
				await storage.close();
			}
		});

		test("takes back an upload its uploader has not sent, and nothing that was sent", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let kept = await upload(storage, channelId, userId);
				let dropped = await upload(storage, channelId, userId);
				let entryId = id("message");
				await storage.chatAttachments.bind({ channelId, userId, ids: [kept.id], entryId });

				expect(await storage.chatAttachments.discard(channelId, kept.id, userId)).toBe(false);
				expect(await storage.chatAttachments.get(channelId, kept.id)).toBeDefined();
				expect(await storage.chatAttachments.discard(channelId, dropped.id, userId)).toBe(true);
				expect(await storage.chatAttachments.get(channelId, dropped.id)).toBeUndefined();
				expect(await storage.chatAttachments.discard(channelId, dropped.id, userId)).toBe(false);
			} finally {
				await storage.close();
			}
		});

		test("forgets a deleted message's files and old uploads nobody sent", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let sent = await upload(storage, channelId, userId, {
					now: new Date("2026-01-01T00:00:00.000Z"),
				});
				let old = await upload(storage, channelId, userId, {
					now: new Date("2026-01-01T00:00:00.000Z"),
				});
				let recent = await upload(storage, channelId, userId, {
					now: new Date("2026-01-03T00:00:00.000Z"),
				});
				let entryId = id("message");
				await storage.chatAttachments.bind({ channelId, userId, ids: [sent.id], entryId });

				// Only what nobody sent and is older than the cut-off goes: a sent file stays however old.
				let cut = new Date("2026-01-02T00:00:00.000Z");
				expect(await storage.chatAttachments.prune(cut)).toBeGreaterThanOrEqual(1);
				expect(await storage.chatAttachments.get(channelId, old.id)).toBeUndefined();
				expect(await storage.chatAttachments.get(channelId, recent.id)).toBeDefined();
				expect(await storage.chatAttachments.get(channelId, sent.id)).toBeDefined();

				expect(await storage.chatAttachments.discardEntry(channelId, entryId)).toBe(1);
				expect(await storage.chatAttachments.forEntry(channelId, entryId)).toEqual([]);
				expect(await storage.chatAttachments.discardEntry(channelId, entryId)).toBe(0);
			} finally {
				await storage.close();
			}
		});

		test("forgets a document's files with the document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let other = await storage.channels.create({
					id: id("attachment-other-channel"),
					repositoryId: id("attachment-other-repository"),
					repositoryOwner: "octo-org",
					repositoryName: "other",
					title: "Other plan",
					createdBy: userId,
					now: NOW,
				});
				let stays = await upload(storage, channelId, userId);
				let goes = await upload(storage, other.id, userId);
				await storage.chatAttachments.bind({
					channelId: other.id,
					userId,
					ids: [goes.id],
					entryId: id("message"),
				});
				await storage.channels.archive({ id: other.id, now: NOW });
				expect(await storage.channels.delete(other.id)).toBe(true);
				expect(await storage.chatAttachments.get(other.id, goes.id)).toBeUndefined();
				expect(await storage.chatAttachments.get(channelId, stays.id)).toBeDefined();
			} finally {
				await storage.close();
			}
		});
	});
}
