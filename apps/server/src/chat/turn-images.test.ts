import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { ulid } from "@chopin/dialect";

import { bigPng } from "../images/raster.test-fixtures";
import { create, documentRoom, endTurnImages, translate } from "./service";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat, Room } from "./service";
import type { SocketData } from "../wire";
import type { Chat as Wire } from "@chopin/protocol";

const be32 = (value: number) => [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255];

function png(width: number, height: number, seed = 0): Uint8Array {
	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...be32(13),
		0x49,
		0x48,
		0x44,
		0x52,
		...be32(width),
		...be32(height),
		8,
		6,
		0,
		0,
		0,
		seed,
	]);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const path = (bytes: Uint8Array) =>
	`/images/${createHash("sha256").update(bytes).digest("hex")}.png`;

type Stored = { channelId: string; sha256: string; mimeType: string; uploadedBy: string };

function turn(
	options: {
		tools?: string[];
		gate?: Promise<void>;
		failing?: (image: Stored) => Error | undefined;
		owner?: false;
		imageMaxBytes?: number;
	} = {},
) {
	let chat: Chat = create();
	let frames: Array<Record<string, unknown>> = [];
	let stored: Stored[] = [];
	let server = {
		publish(_topic: string, data: string) {
			frames.push(JSON.parse(data) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;
	let context = {
		chat,
		server,
		room: "doc",
		plan: {},
		config: options.imageMaxBytes === undefined ? {} : { imageMaxBytes: options.imageMaxBytes },
		auth: {
			clock: () => new Date(0),
			storage: {
				channels: { get: async (id: string) => ({ id, archivedAt: null }) },
				images: {
					put: async (image: Stored) => {
						await options.gate;
						let failure = options.failing?.(image);
						if (failure) throw failure;
						stored.push(image);
					},
				},
			},
			sessions: { resolve: async () => ({ user: { id: "owner-user" } }) },
		},
		activeOwner: async () =>
			options.owner === false ? undefined : { ownerSessionId: "s", release: () => {} },
	} as unknown as Room;
	chat.agent = { activeTools: options.tools ?? ["codemode"] } as never;
	chat.busy = true;
	chat.turnController = new AbortController();
	let entryId = ulid();
	chat.entries.push({
		id: entryId,
		author: { kind: "member", handle: "ana" },
		text: "Draw the floor plan",
		ts: 1,
	});
	chat.turn = {
		id: "turn-1",
		handle: "ana",
		started: 1,
		startedAt: 1,
		entryOffset: 0,
		responded: false,
	};
	chat.activeRequest = {
		entryId,
		userId: "member-user",
		handle: "ana",
		text: "Draw the floor plan",
		claimantSessionId: undefined,
		turnId: "turn-1",
		lifecycle: chat.lifecycle,
	};
	let send = (value: Record<string, unknown>) =>
		translate(context, value as TextStreamPart<ToolSet>);
	let shown = () =>
		frames.filter(frame => frame.kind === "chat:message" && (frame.entry as Wire.Entry).images)
			.map(frame => frame.entry as Wire.Entry);
	return { chat, context, frames, stored, send, shown };
}

function toolResult(id: string, content: unknown[]) {
	return {
		type: "tool-result",
		toolCallId: id,
		toolName: "codemode",
		input: {},
		output: { content },
	};
}

describe("images a turn makes", () => {
	it("store a tool's images as the document's own before Chat shows them as generated parts", async () => {
		let release!: () => void;
		let gate = new Promise<void>(resolve => (release = resolve));
		let { chat, send, shown, stored } = turn({ gate });
		let plan = png(800, 600, 1);
		send({ type: "text-start", id: "t" });
		send({ type: "text-delta", id: "t", text: "Here is the plan." });
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "text", text: "Image saved to /tmp/atomic/plan.png" },
			{
				type: "image",
				data: base64(plan),
				mimeType: "image/png",
				alt: "Ground floor",
				caption: "",
			},
		]));
		await Bun.sleep(0);
		expect(stored).toEqual([]);
		expect(shown()).toEqual([]);

		release();
		await chat.turnImages?.work;
		expect(stored).toEqual([expect.objectContaining({
			channelId: "doc",
			sha256: path(plan).slice(8, 72),
			mimeType: "image/png",
			uploadedBy: "member-user",
		})]);
		let entry = chat.entries.find(item => item.author.kind === "agent")!;
		expect(entry.text).toBe("Here is the plan.");
		expect(entry.images).toEqual([{
			src: path(plan),
			alt: "Ground floor",
			caption: "",
			width: 800,
			height: 600,
			generated: true,
		}]);
		expect(shown().at(-1)?.images).toEqual(entry.images);
		let row = entry.tools?.find(tool => tool.id === "c1");
		expect(row?.result).toBe("Image saved to /tmp/atomic/plan.png\n1 image");
		expect(JSON.stringify(chat.entries)).not.toContain(base64(plan));
	});

	it("collect on one message, in the order they were made, and never twice for one call", async () => {
		let { chat, send } = turn();
		let first = png(100, 50, 1);
		let second = png(50, 100, 2);
		let third = png(10, 10, 3);
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [{ type: "image", data: base64(first), mimeType: "image/png" }]));
		send(toolResult("c1", [{ type: "image", data: base64(first), mimeType: "image/png" }]));
		send({ type: "text-start", id: "t" });
		send({ type: "text-delta", id: "t", text: "And two more." });
		send({ type: "text-end", id: "t" });
		send({ type: "tool-call", toolCallId: "c2", toolName: "codemode", input: {} });
		send(toolResult("c2", [
			{ type: "image", data: base64(second), mimeType: "image/png", alt: "Tall" },
			{ type: "image", data: base64(third), mimeType: "image/png", alt: "Small" },
		]));
		await chat.turnImages?.work;
		let holders = chat.entries.filter(entry => entry.images);
		expect(holders).toHaveLength(1);
		expect(holders[0]!.images!.map(image => [image.src, image.alt])).toEqual([
			[path(first), undefined],
			[path(second), "Tall"],
			[path(third), "Small"],
		]);
	});

	it("leave out an image Chopin will not host and show none of a failed or partial result", async () => {
		let { chat, send, stored } = turn();
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send({
			...toolResult("c1", [{ type: "image", data: base64(png(9, 9)), mimeType: "image/png" }]),
			preliminary: true,
		});
		send({ type: "tool-call", toolCallId: "c2", toolName: "codemode", input: {} });
		send({
			type: "tool-error",
			toolCallId: "c2",
			toolName: "codemode",
			input: {},
			error: { content: [{ type: "image", data: base64(png(9, 9)), mimeType: "image/png" }] },
		});
		send({ type: "tool-call", toolCallId: "c3", toolName: "codemode", input: {} });
		send(toolResult("c3", [{ type: "image", data: base64(svg), mimeType: "image/svg+xml" }]));
		await chat.turnImages?.work;
		expect(stored).toEqual([]);
		expect(chat.entries.some(entry => entry.images)).toBe(false);
	});

	it("show an image the Planner uploads, with the alt text it gave", async () => {
		let { chat, context, shown, stored } = turn();
		let drawing = png(640, 480, 4);
		let { path: src } = await documentRoom(context).uploadImage!({
			bytes: drawing,
			mimeType: "image/png",
			alt: "Write-through: [write], cache, database",
		});
		await chat.turnImages?.work;
		expect(stored).toHaveLength(1);
		expect(src).toBe(path(drawing));
		expect(shown().at(-1)).toMatchObject({
			author: { kind: "agent" },
			text: "",
			images: [{
				src,
				alt: "Write-through: [write], cache, database",
				width: 640,
				height: 480,
				generated: true,
			}],
		});
	});

	it("show why a stored Planner upload with an unreadable header cannot be shown, with its alt", async () => {
		let { chat, context, frames, stored } = turn();
		let damaged = png(640, 480).slice(0, 20);
		let { path: src } = await documentRoom(context).uploadImage!({
			bytes: damaged,
			mimeType: "image/png",
			alt: "Floor plan of the ground floor",
		});
		await chat.turnImages?.work;
		expect(src).toBe(path(damaged));
		expect(stored).toHaveLength(1);
		let entries = chat.entries.filter(entry => entry.refusedImages);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.refusedImages).toEqual([{
			before: 0,
			reason:
				"Image couldn't be shown: its PNG header can't be read, so the image is cut short or damaged. Alt: Floor plan of the ground floor",
		}]);
		expect(frames.filter(frame => frame.kind === "chat:message").at(-1)?.entry).toMatchObject({
			refusedImages: entries[0]!.refusedImages,
		});
	});

	it("never show an upload that settles after its turn ended, nor let it take the next turn's", async () => {
		let release!: () => void;
		let gate = new Promise<void>(resolve => (release = resolve));
		let { chat, context, send, shown } = turn({ gate });
		let late = documentRoom(context).uploadImage!({
			bytes: png(4, 3, 5),
			mimeType: "image/png",
			alt: "Late",
		});
		await Bun.sleep(0);
		chat.turnController!.abort();
		await endTurnImages(chat);
		chat.busy = false;
		chat.turnController = undefined;
		release();
		await late;
		await chat.turnImages?.work;
		expect(shown()).toEqual([]);
		expect(chat.entries.some(entry => entry.images)).toBe(false);

		chat.busy = true;
		chat.turnController = new AbortController();
		send({ type: "text-start", id: "t2" });
		send({ type: "text-delta", id: "t2", text: "Turn two" });
		send({ type: "tool-call", toolCallId: "c2", toolName: "codemode", input: {} });
		send(toolResult("c2", [{
			type: "image",
			data: base64(png(8, 8, 6)),
			mimeType: "image/png",
			alt: "Turn two's",
		}]));
		await endTurnImages(chat);
		let holders = chat.entries.filter(entry => entry.images);
		expect(holders.map(entry => [entry.text, entry.images!.map(image => image.alt)])).toEqual([
			["Turn two", ["Turn two's"]],
		]);
	});

	it("keep an image with the tool that made it when its result arrives with no earlier call and the store is slow", async () => {
		let release!: () => void;
		let gate = new Promise<void>(resolve => (release = resolve));
		let { chat, send } = turn({ gate });
		send({ type: "text-start", id: "t1" });
		send({ type: "text-delta", id: "t1", text: "First message" });
		send(toolResult("orphan", [{
			type: "image",
			data: base64(png(40, 30, 9)),
			mimeType: "image/png",
			alt: "Orphan",
		}]));
		send({ type: "text-end", id: "t1" });
		send({ type: "text-start", id: "t2" });
		send({ type: "text-delta", id: "t2", text: "Second message" });
		await Bun.sleep(0);
		release();
		await endTurnImages(chat);
		let holders = chat.entries.filter(entry => entry.images);
		expect(holders.map(entry => [
			entry.text,
			entry.tools?.map(tool => tool.id),
			entry.images!.map(image => image.alt),
		])).toEqual([["First message", ["orphan"], ["Orphan"]]]);
	});

	it("say why an image was left out on the message that holds the turn's others, in its place", async () => {
		let release!: () => void;
		let gate = new Promise<void>(resolve => (release = resolve));
		let { chat, frames, send } = turn({ gate });
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		let first = png(100, 50, 1);
		let second = png(50, 100, 2);
		send({ type: "text-start", id: "t" });
		send({ type: "text-delta", id: "t", text: "Here are two." });
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(first), mimeType: "image/png", alt: "First" },
			{ type: "image", data: base64(svg), mimeType: "image/svg+xml" },
			{ type: "image", data: base64(second), mimeType: "image/png", alt: "Second" },
			{ type: "image", data: "not base64!", mimeType: "image/png" },
			{ type: "image", data: "not base64!", mimeType: "image/png" },
		]));
		await Bun.sleep(0);
		expect(frames.some(frame => (frame.entry as Wire.Entry | undefined)?.refusedImages)).toBe(
			false,
		);

		release();
		await chat.turnImages?.work;
		let holders = chat.entries.filter(entry => entry.images || entry.refusedImages);
		expect(holders).toHaveLength(1);
		let [entry] = holders;
		expect(entry!.author.kind).toBe("agent");
		expect(entry!.text).toBe("Here are two.");
		expect(entry!.images!.map(image => image.alt)).toEqual(["First", "Second"]);
		expect(entry!.refusedImages).toEqual([
			{
				before: 1,
				reason:
					"Image couldn't be shown: its type image/svg+xml isn't one Chat shows (PNG, JPEG, WebP, GIF, AVIF, BMP or ICO).",
			},
			{ before: 2, reason: "Image couldn't be shown: its data isn't valid base64." },
			{ before: 2, reason: "Image couldn't be shown: its data isn't valid base64." },
		]);
		let sent = frames.filter(frame => frame.kind === "chat:message").map(frame =>
			frame.entry as Wire.Entry
		).filter(item => item.refusedImages);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.images).toHaveLength(2);
		expect(sent[0]!.refusedImages).toEqual(entry!.refusedImages);
		expect(entry!.tools?.find(tool => tool.id === "c1")?.result).toBe("5 images");
	});

	it("say why on a message of their own when none of a turn's images could be shown", async () => {
		let { chat, send, stored } = turn();
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		let cut = png(9, 9).slice(0, 20);
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(svg), mimeType: "image/svg+xml" },
			{ type: "image", data: base64(cut), mimeType: "image/png" },
			{ type: "image", data: base64(png(9, 9)), mimeType: "image/avif" },
		]));
		await chat.turnImages?.work;
		expect(stored).toEqual([]);
		let holders = chat.entries.filter(entry => entry.refusedImages);
		expect(holders).toHaveLength(1);
		expect(holders[0]).toMatchObject({ author: { kind: "agent" }, text: "" });
		expect(holders[0]!.images).toBeUndefined();
		expect(holders[0]!.refusedImages).toEqual([
			{
				before: 0,
				reason:
					"Image couldn't be shown: its type image/svg+xml isn't one Chat shows (PNG, JPEG, WebP, GIF, AVIF, BMP or ICO).",
			},
			{
				before: 0,
				reason:
					"Image couldn't be shown: its PNG header can't be read, so the image is cut short or damaged.",
			},
			{
				before: 0,
				reason: "Image couldn't be shown: its bytes are PNG data, not AVIF as its type says.",
			},
		]);
	});

	it("keep each call's refusals in their own place among the images of the message, never twice for one call", async () => {
		let { chat, send } = turn();
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		let first = png(100, 50, 1);
		let second = png(50, 100, 2);
		let bad = { type: "image", data: base64(svg), mimeType: "image/svg+xml" };
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(first), mimeType: "image/png", alt: "First" },
			bad,
		]));
		send(toolResult("c1", [bad]));
		send({ type: "tool-call", toolCallId: "c2", toolName: "codemode", input: {} });
		send(toolResult("c2", [bad, bad, {
			type: "image",
			data: base64(second),
			mimeType: "image/png",
			alt: "Second",
		}]));
		await chat.turnImages?.work;
		let holders = chat.entries.filter(entry => entry.images || entry.refusedImages);
		expect(holders).toHaveLength(1);
		expect(holders[0]!.images!.map(image => image.alt)).toEqual(["First", "Second"]);
		expect(holders[0]!.refusedImages!.map(item => item.before)).toEqual([1, 1, 1]);
	});

	it("say nothing of an image in a failed or partial result", async () => {
		let { chat, send } = turn();
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		let bad = [{ type: "image", data: base64(svg), mimeType: "image/svg+xml" }];
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send({ ...toolResult("c1", bad), preliminary: true });
		send({
			type: "tool-error",
			toolCallId: "c2",
			toolName: "codemode",
			input: {},
			error: { content: bad },
		});
		await chat.turnImages?.work;
		expect(chat.entries.some(entry => entry.refusedImages)).toBe(false);
	});

	it("say an image could not be stored in its place, keep the others, and give no detail of why", async () => {
		let failing = png(60, 40, 2);
		let { chat, send, stored } = turn({
			failing: image =>
				image.sha256 === path(failing).slice(8, 72)
					? new Error("connection to postgres://chopin:hunter2@db.internal failed")
					: undefined,
		});
		let svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(png(50, 30, 1)), mimeType: "image/png", alt: "A" },
			{ type: "image", data: base64(svg), mimeType: "image/svg+xml" },
			{ type: "image", data: base64(failing), mimeType: "image/png", alt: "B" },
			{ type: "image", data: base64(png(20, 10, 3)), mimeType: "image/png", alt: "C" },
		]));
		await chat.turnImages?.work;
		expect(stored).toHaveLength(2);
		let entry = chat.entries.find(item => item.images);
		expect(entry!.images!.map(image => image.alt)).toEqual(["A", "C"]);
		expect(entry!.refusedImages).toEqual([
			{
				before: 1,
				reason:
					"Image couldn't be shown: its type image/svg+xml isn't one Chat shows (PNG, JPEG, WebP, GIF, AVIF, BMP or ICO).",
			},
			{ before: 1, reason: "Image couldn't be shown: Chopin couldn't store it." },
		]);
		expect(JSON.stringify(chat.entries)).not.toContain("hunter2");
	});

	it("say none could be stored when nobody can own what the turn makes", async () => {
		let { chat, send, stored } = turn({ owner: false });
		chat.activeRequest = undefined;
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(png(50, 30, 1)), mimeType: "image/png" },
			{ type: "image", data: base64(png(50, 30, 2)), mimeType: "image/png" },
		]));
		await chat.turnImages?.work;
		expect(stored).toEqual([]);
		let entry = chat.entries.find(item => item.refusedImages);
		expect(entry!.images).toBeUndefined();
		expect(entry!.refusedImages).toEqual([
			{ before: 0, reason: "Image couldn't be shown: Chopin couldn't store it." },
			{ before: 0, reason: "Image couldn't be shown: Chopin couldn't store it." },
		]);
	});

	it("host a tool's image of exactly the stored limit and say an image one byte over was too large, storing nothing of it", async () => {
		let limit = 2 * 1_048_576;
		let { chat, send, stored } = turn({ imageMaxBytes: limit });
		let at = bigPng(limit);
		let over = bigPng(limit + 1);
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [
			{ type: "image", data: base64(over), mimeType: "image/png", alt: "Over" },
			{ type: "image", data: base64(at), mimeType: "image/png", alt: "At" },
		]));
		await chat.turnImages?.work;
		expect(stored.map(image => image.sha256)).toEqual([path(at).slice(8, 72)]);
		let entry = chat.entries.find(item => item.images);
		expect(entry!.images!.map(image => image.alt)).toEqual(["At"]);
		expect(entry!.refusedImages).toEqual([
			{ before: 0, reason: "Image too large to show (2.1 MB, limit 2 MB)" },
		]);
		expect(entry!.tools?.find(tool => tool.id === "c1")?.result).toBe("2 images");
		expect(JSON.stringify(chat.entries)).not.toContain(base64(over).slice(0, 5000));
	});

	it("say on a message of its own that an image was too large when none could be shown, with the 10 MiB default", async () => {
		let { chat, send, stored } = turn();
		let over = bigPng(10 * 1_048_576 + 1);
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send(toolResult("c1", [{ type: "image", data: base64(over), mimeType: "image/png" }]));
		await chat.turnImages?.work;
		expect(stored).toEqual([]);
		let holders = chat.entries.filter(entry => entry.refusedImages);
		expect(holders).toHaveLength(1);
		expect(holders[0]).toMatchObject({ author: { kind: "agent" }, text: "" });
		expect(holders[0]!.images).toBeUndefined();
		expect(holders[0]!.refusedImages).toEqual([
			{ before: 0, reason: "Image too large to show (10.1 MB, limit 10 MB)" },
		]);
	});
});
