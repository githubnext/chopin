import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { ulid } from "@chopin/dialect";

import { create, documentRoom, translate } from "./service";

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

function turn(options: { tools?: string[]; gate?: Promise<void> } = {}) {
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
		config: {},
		auth: {
			clock: () => new Date(0),
			storage: {
				channels: { get: async (id: string) => ({ id, archivedAt: null }) },
				images: {
					put: async (image: Stored) => {
						await options.gate;
						stored.push(image);
					},
				},
			},
			sessions: { resolve: async () => ({ user: { id: "owner-user" } }) },
		},
		activeOwner: async () => ({ ownerSessionId: "s", release: () => {} }),
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
		await chat.imageWork;
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
		await chat.imageWork;
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
		await chat.imageWork;
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
		await chat.imageWork;
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
});
