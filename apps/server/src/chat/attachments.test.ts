import { expect, test } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import * as Chat from "./service";
import { harness, installJobCleanup, member, until } from "./job.test-fixtures";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { PlannerFiles } from "../harness/session";
import type { Socket } from "../wire";

installJobCleanup();

const NOW = new Date("2026-10-09T12:00:00.000Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const LIMITS = { maxBytes: 64, maxCount: 2, maxTotalBytes: 96 };

type Failure = { kind: string; message: string; code?: string };

/** A room whose files are kept in real storage, and a Planner session that records what it is given. */
async function setup(
	limits: typeof LIMITS | { maxBytes: number; maxCount: number; maxTotalBytes: number } = LIMITS,
) {
	let h = harness();
	let storage = new MemoryStorage();
	for (let id of ["U_ana", "U_bo"]) {
		await storage.users.put({ id, login: id.slice(2), avatarUrl: "a", now: NOW });
	}
	await storage.channels.create({
		id: "room",
		repositoryId: "repo",
		repositoryOwner: "owner",
		repositoryName: "repo",
		title: "Plan",
		createdBy: "U_ana",
		now: NOW,
	});
	let context = h.context as unknown as {
		auth: { storage: { chatAttachments: MemoryStorage["chatAttachments"] } };
		config: Config;
		readsImages?: () => Promise<boolean>;
		openPlannerSession: unknown;
	};
	context.auth.storage.chatAttachments = storage.chatAttachments;
	context.config = { agent: true, harness: "copilot-sdk", chatAttachments: limits } as Config;
	context.readsImages = async () => false;
	let turns: Array<{ prompt: string; files?: PlannerFiles }> = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream(prompt: string, _signal: AbortSignal, _choice: unknown, files?: PlannerFiles) {
				turns.push({ prompt, files });
				return {
					fullStream: (async function*() {
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	let upload = async (
		by: string,
		name: string,
		bytes: Uint8Array | string,
		kind: "image" | "file" = "file",
	) => {
		let id = `file-${crypto.randomUUID()}`;
		await storage.chatAttachments.put({
			id,
			channelId: "room",
			name,
			kind,
			mimeType: kind === "image" ? "image/png" : "text/plain",
			bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
			uploadedBy: by,
			now: NOW,
		});
		return id;
	};
	let replies: Array<Record<string, unknown>> = [];
	let ana = {
		data: { handle: "ana", principalId: "U_ana" },
		send: (text: string) => replies.push(JSON.parse(text)),
	} as unknown as Socket;
	let send = async (message: Partial<Wire.Send> & { text: string }, who: Socket = ana) => {
		replies.length = 0;
		let request = { ...member(message.text), ...message } as Request<Wire.Send>;
		await Chat.send(h.context, who, request);
		return { request, reply: replies.at(-1) as (Failure & Wire.Sent) | undefined };
	};
	return { h, storage, upload, send, turns, context, ana };
}

test("a room message carries its files for everyone, in the order they were sent", async () => {
	let { h, storage, upload, send } = await setup();
	let first = await upload("U_ana", "notes.md", "# Notes\n");
	let second = await upload("U_ana", "shot.png", PNG, "image");
	let { request, reply } = await send({ to: "room", text: "Look", attachments: [second, first] });
	expect(reply?.kind).toBe("chat:send");
	let entry = h.chat.entries.find(value => value.id === request.requestId)!;
	expect(entry.attachments).toEqual([
		{ id: second, name: "shot.png", kind: "image", mimeType: "image/png", size: PNG.byteLength },
		{ id: first, name: "notes.md", kind: "file", mimeType: "text/plain", size: 8 },
	]);
	expect((await storage.chatAttachments.forEntry("room", request.requestId)).map(value => value.id))
		.toEqual([second, first]);
	// What clients are told is the entry, files included, and nothing of the bytes.
	let told = JSON.stringify(h.frames.filter(frame => frame.kind === "chat:message"));
	expect(told).toContain("shot.png");
	expect(told).not.toContain("bytes");
});

test("a message may be only files", async () => {
	let { h, upload, send } = await setup();
	let id = await upload("U_ana", "notes.txt", "hi");
	let { request, reply } = await send({ to: "room", text: "", attachments: [id] });
	expect(reply?.kind).toBe("chat:send");
	expect(h.chat.entries.find(value => value.id === request.requestId)?.attachments).toHaveLength(1);
	let none = await send({ to: "room", text: "" });
	expect(none.reply).toMatchObject({ kind: "session:error", message: "message text is empty" });
});

test("a retried send with the same files is answered as kept, and one with other files is refused", async () => {
	let { h, upload, send } = await setup();
	let id = await upload("U_ana", "a.txt", "a");
	let other = await upload("U_ana", "b.txt", "b");
	let { request } = await send({ to: "room", text: "Look", attachments: [id] });
	let again = await send({ ...request, attachments: [id] } as never);
	expect(again.reply?.kind).toBe("chat:send");
	expect(h.chat.entries.filter(value => value.id === request.requestId)).toHaveLength(1);
	let different = await send({ ...request, attachments: [other] } as never);
	expect(different.reply).toMatchObject({
		kind: "session:error",
		message: "chat request id was reused with different content",
	});
});

test("refuses a file that is not the sender's, is missing, or is already sent with another message", async () => {
	let { h, upload, send } = await setup();
	let theirs = await upload("U_bo", "bo.txt", "bo");
	let mine = await upload("U_ana", "ana.txt", "ana");
	let words = "A file is no longer available.";
	for (let attachments of [[theirs], ["missing"], [mine, theirs]]) {
		let { reply } = await send({ to: "room", text: "Look", attachments });
		expect(reply, JSON.stringify(attachments)).toMatchObject({ kind: "session:error" });
		expect(reply?.message.toLowerCase()).toContain("no longer available");
		expect(words.length).toBeGreaterThan(0);
	}
	expect(h.chat.entries).toHaveLength(0);
	await send({ to: "room", text: "First", attachments: [mine] });
	let reused = await send({ to: "room", text: "Second", attachments: [mine] });
	expect(reused.reply).toMatchObject({ kind: "session:error" });
	expect(h.chat.entries).toHaveLength(1);
});

test("holds a message to the count and the total, and refuses what is not a list of ids", async () => {
	let { h, upload, send } = await setup();
	let a = await upload("U_ana", "a.txt", "a".repeat(60));
	let b = await upload("U_ana", "b.txt", "b".repeat(40));
	let c = await upload("U_ana", "c.txt", "c");
	let count = await send({ to: "room", text: "Look", attachments: [a, b, c] });
	expect(count.reply?.message).toBe("A message can carry up to 2 files.");
	let total = await send({ to: "room", text: "Look", attachments: [a, b] });
	expect(total.reply?.message).toBe("The files in a message can total up to 96 B.");
	for (let attachments of [[], "a", [1], [a, a], [""]] as unknown[]) {
		let bad = await send({ to: "room", text: "Look", attachments: attachments as string[] });
		expect(bad.reply?.message, JSON.stringify(attachments)).toBe("invalid files");
	}
	expect(h.chat.entries).toHaveLength(0);
});

test("takes no files where the server is set to take none", async () => {
	let { h, upload, send, context } = await setup();
	let id = await upload("U_ana", "a.txt", "a");
	context.config = {
		agent: true,
		harness: "copilot-sdk",
		chatAttachments: { ...LIMITS, maxCount: 0 },
	} as Config;
	let { reply } = await send({ to: "room", text: "Look", attachments: [id] });
	expect(reply?.message).toBe("files are not accepted here");
	expect(h.chat.entries).toHaveLength(0);
});

test("gives the Planner a text file as a file and says nothing of images its model cannot read", async () => {
	let { h, upload, send, turns } = await setup();
	let notes = await upload("U_ana", "notes.md", "# Notes\n");
	let { request, reply } = await send({ to: "planner", text: "Read this", attachments: [notes] });
	expect(reply?.kind).toBe("chat:send");
	await until(() => turns.length === 1);
	expect(turns[0]!.files?.readsImages).toBe(false);
	expect(turns[0]!.files?.attachments.map(value => [value.name, value.kind, value.mimeType]))
		.toEqual([
			["notes.md", "file", "text/plain"],
		]);
	expect(new TextDecoder().decode(turns[0]!.files!.attachments[0]!.bytes)).toBe("# Notes\n");
	expect(h.chat.entries.find(value => value.id === request.requestId)?.attachments).toHaveLength(1);
	await until(() => !h.chat.busy);
});

test("refuses an image for a Planner whose model does not read images, and sends nothing", async () => {
	let { h, upload, send, turns, storage } = await setup();
	let shot = await upload("U_ana", "shot.png", PNG, "image");
	let refused = await send({ to: "planner", text: "What is this?", attachments: [shot] });
	expect(refused.reply?.message).toBe(
		"This model can't read images. Send it as text, or to the room.",
	);
	expect(h.chat.entries).toHaveLength(0);
	expect(turns).toHaveLength(0);
	expect((await storage.chatAttachments.get("room", shot))?.entryId).toBeUndefined();
	// The same file goes to the room, where people read it.
	let room = await send({ to: "room", text: "What is this?", attachments: [shot] });
	expect(room.reply?.kind).toBe("chat:send");
});

test("gives the Planner an image where its model reads images", async () => {
	let { h, upload, send, turns, context } = await setup();
	context.readsImages = async () => true;
	let shot = await upload("U_ana", "shot.png", PNG, "image");
	let { reply } = await send({ to: "planner", text: "What is this?", attachments: [shot] });
	expect(reply?.kind).toBe("chat:send");
	await until(() => turns.length === 1);
	expect(turns[0]!.files).toMatchObject({ readsImages: true });
	expect(turns[0]!.files!.attachments[0]).toMatchObject({
		name: "shot.png",
		kind: "image",
		mimeType: "image/png",
	});
	expect(new Uint8Array(turns[0]!.files!.attachments[0]!.bytes)).toEqual(PNG);
	await until(() => !h.chat.busy);
});

test("a queued message keeps its files until its turn, then shows and sends them", async () => {
	let { h, upload, send, turns } = await setup();
	let first = await send({ to: "planner", text: "First turn" });
	expect(first.reply?.kind).toBe("chat:send");
	let notes = await upload("U_ana", "notes.md", "queued notes");
	let queued = await send({ to: "planner", text: "Then this", attachments: [notes] });
	await until(() => turns.length >= 1);
	await until(() => !h.chat.busy && turns.length === 2);
	let entry = h.chat.entries.find(value => value.id === queued.request.requestId);
	expect(entry?.attachments?.map(value => value.name)).toEqual(["notes.md"]);
	expect(turns[1]!.files?.attachments.map(value => value.name)).toEqual(["notes.md"]);
	expect(turns[0]!.files).toBeUndefined();
});

test("deleting a message takes its files with it", async () => {
	let { h, upload, send, storage } = await setup();
	h.context.deferred = undefined;
	let id = await upload("U_ana", "notes.txt", "hi");
	let { request } = await send({ to: "room", text: "Look", attachments: [id] });
	let entry = h.chat.entries.find(value => value.id === request.requestId)!;
	(entry as Wire.Entry).deliveryState = "failed";
	let deleted: unknown;
	let ana = {
		data: { handle: "ana", principalId: "U_ana" },
		send: (text: string) => deleted = JSON.parse(text),
	} as unknown as Socket;
	await Chat.remove(h.context, ana, {
		kind: "chat:delete",
		rid: "d",
		id: request.requestId,
		ts: 0,
	});
	expect(deleted).toMatchObject({ kind: "chat:delete" });
	await until(() =>
		storage.chatAttachments.get("room", id).then(value => value === undefined) as never
	);
	expect(await storage.chatAttachments.forEntry("room", request.requestId)).toEqual([]);
});

test("a send with no files keeps the shape it always had", async () => {
	let { h, send, turns } = await setup();
	let { request } = await send({ to: "planner", text: "Plain" });
	await until(() => turns.length === 1);
	expect(turns[0]!.files).toBeUndefined();
	expect(h.chat.entries.find(value => value.id === request.requestId)).not.toHaveProperty(
		"attachments",
	);
	await until(() => !h.chat.busy);
});
