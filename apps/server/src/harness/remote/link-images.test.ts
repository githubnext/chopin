import { afterEach, describe, expect, it } from "bun:test";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { ulid } from "@chopin/dialect";

import { create, translate } from "../../chat/service";
import { bigPng, fixture } from "../../images/raster.test-fixtures";
import {
	attach,
	finishTurn,
	linkAuth,
	linkServer,
	scriptedPlanner,
} from "../../testing/agent-link";
import { createRemoteAdapter } from "./adapter";

import type { TextStreamPart, ToolSet } from "ai";
import type { Room } from "../../chat/service";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const PNG = new Uint8Array([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0,
	0,
	0,
	13,
	0x49,
	0x48,
	0x44,
	0x52,
	0,
	0,
	4,
	0,
	0,
	0,
	3,
	0,
	8,
	2,
	0,
	0,
	0,
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

const hashOf = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function drawn(content: Array<Record<string, string>>) {
	let { auth, storage, channel } = await linkAuth();
	let server = linkServer(auth, 300);
	cleanups.push(server.stop);
	let script = scriptedPlanner();
	let result = { content };
	let client = await attach(server.url, channel.id, {
		...script.handlers,
		async turn(context) {
			context.offerTools(["draw"]);
			context.emit({
				type: "tool-call",
				toolCallId: "draw-1",
				toolName: "draw",
				input: "{}",
				providerExecuted: true,
			});
			context.emit({ type: "tool-result", toolCallId: "draw-1", toolName: "draw", result });
			finishTurn(context);
		},
	});
	cleanups.push(() => client.detach());

	let harness = createRemoteAdapter(() => ({
		link: server.links.at(-1)!,
		planner: { channelId: channel.id, isolated: false },
	}));
	let agent = new HarnessAgent({ harness, tools: {}, permissionMode: "allow-reads" });
	let session = await agent.createSession({
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			async run() {
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			async destroy() {},
		} as never,
	});
	cleanups.push(() => session.destroy());

	let chat = create();
	chat.agent = { activeTools: ["draw"] } as never;
	chat.busy = true;
	chat.turnController = new AbortController();
	let entryId = ulid();
	chat.entries.push({
		id: entryId,
		author: { kind: "member", handle: "member" },
		text: "Draw it",
		ts: 1,
	});
	chat.turn = {
		id: "turn-1",
		handle: "member",
		started: 1,
		startedAt: 1,
		entryOffset: 1,
		responded: false,
	};
	chat.activeRequest = {
		entryId,
		userId: "U_member",
		handle: "member",
		text: "Draw it",
		claimantSessionId: undefined,
		turnId: "turn-1",
		lifecycle: chat.lifecycle,
	};
	let context = {
		chat,
		server: { publish() {} },
		room: channel.id,
		plan: {},
		config: {},
		auth: { clock: () => new Date(), storage },
	} as unknown as Room;
	let stream = await agent.stream({ session, prompt: "Draw it" });
	for await (let part of stream.fullStream) translate(context, part as TextStreamPart<ToolSet>);
	await chat.turnImages?.work;
	return { chat, storage, channel };
}

describe("images over the agent connection", () => {
	it("reach Chat as stored image parts when a client's tool result carries image blocks", async () => {
		let { chat, storage, channel } = await drawn([
			{ type: "text", text: "Drew the floor plan" },
			{
				type: "image",
				data: Buffer.from(PNG).toString("base64"),
				mimeType: "image/png",
				alt: "Ground floor",
				caption: "Draft one",
			},
			{ type: "image", data: Buffer.from(SVG).toString("base64"), mimeType: "image/svg+xml" },
		]);

		let entry = chat.entries.find(item => item.images);
		let sha256 = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");
		expect(entry?.images).toEqual([{
			src: `/images/${sha256}.png`,
			alt: "Ground floor",
			caption: "Draft one",
			width: 1024,
			height: 768,
			generated: true,
		}]);
		expect(entry?.tools?.[0]?.result).toBe("Drew the floor plan\n2 images");
		expect(await storage.images.get(channel.id, sha256)).toMatchObject({
			mimeType: "image/png",
			bytes: PNG,
			uploadedBy: "U_member",
		});
		expect(
			await storage.images.channels(
				new Bun.CryptoHasher("sha256").update(SVG).digest("hex"),
			),
		).toEqual([]);
	});

	it("reach Chat whole when a client's picture is over a megabyte, as the link carries it", async () => {
		let picture = bigPng(1_080_993);
		let { chat, storage, channel } = await drawn([
			{
				type: "image",
				data: Buffer.from(picture).toString("base64"),
				mimeType: "image/png",
				alt: "A large plan",
			},
		]);

		let sha256 = new Bun.CryptoHasher("sha256").update(picture).digest("hex");
		expect(chat.entries.find(item => item.images)?.images).toEqual([{
			src: `/images/${sha256}.png`,
			alt: "A large plan",
			width: 40,
			height: 30,
			generated: true,
		}]);
		let stored = await storage.images.get(channel.id, sha256);
		expect(stored).toMatchObject({
			mimeType: "image/png",
			size: 1_080_993,
			uploadedBy: "U_member",
		});
		expect(new Bun.CryptoHasher("sha256").update(stored!.bytes).digest("hex")).toBe(sha256);
	});

	it("store each raster a browser draws as the type its bytes are, and refuse one named as another", async () => {
		let avif = fixture("raster-18x6.avif");
		let icon = fixture("raster-6x18.ico");
		let bitmap = fixture("raster-18x6.bmp");
		let { chat, storage, channel } = await drawn([
			{ type: "image", data: encoded(avif), mimeType: "image/avif", alt: "First" },
			{ type: "image", data: encoded(icon), mimeType: "image/vnd.microsoft.icon" },
			{ type: "image", data: encoded(bitmap), mimeType: "image/x-ms-bmp", caption: "A bitmap" },
			{ type: "image", data: encoded(avif), mimeType: "image/avif", alt: "Again" },
			{ type: "image", data: encoded(avif), mimeType: "image/png" },
		]);

		let entry = chat.entries.find(item => item.images);
		expect(entry?.images).toEqual([
			{ src: `/images/${hashOf(avif)}.avif`, alt: "First", width: 18, height: 6, generated: true },
			{ src: `/images/${hashOf(icon)}.ico`, width: 6, height: 18, generated: true },
			{
				src: `/images/${hashOf(bitmap)}.bmp`,
				caption: "A bitmap",
				width: 18,
				height: 6,
				generated: true,
			},
			{ src: `/images/${hashOf(avif)}.avif`, alt: "Again", width: 18, height: 6, generated: true },
		]);
		expect(entry?.tools?.[0]?.result).toBe("5 images");
		for (
			let [bytes, mimeType] of [[avif, "image/avif"], [icon, "image/x-icon"], [
				bitmap,
				"image/bmp",
			]] as const
		) {
			expect(await storage.images.get(channel.id, hashOf(bytes)), mimeType).toMatchObject({
				mimeType,
				bytes,
				uploadedBy: "U_member",
			});
		}
	});

	it("say why each image a client sent could not be shown, where it would have been among the others", async () => {
		let avif = fixture("raster-18x6.avif");
		let { chat } = await drawn([
			{ type: "text", text: "Drew five" },
			{ type: "image", data: encoded(PNG), mimeType: "image/png", alt: "Ground floor" },
			{ type: "image", data: encoded(SVG), mimeType: "image/svg+xml" },
			{ type: "image", data: encoded(avif), mimeType: "image/png" },
			{ type: "image", data: encoded(PNG.slice(0, 20)), mimeType: "image/png" },
			{ type: "image", data: "not base64!", mimeType: "image/png" },
			{ type: "image", data: encoded(avif), mimeType: "image/avif", alt: "First floor" },
		]);

		let entry = chat.entries.find(item => item.images);
		expect(entry?.images?.map(image => image.alt)).toEqual(["Ground floor", "First floor"]);
		expect(entry?.refusedImages).toEqual([
			{
				before: 1,
				reason:
					"Image couldn't be shown: its type image/svg+xml isn't one Chat shows (PNG, JPEG, WebP, GIF, AVIF, BMP or ICO).",
			},
			{
				before: 1,
				reason: "Image couldn't be shown: its bytes are AVIF data, not PNG as its type says.",
			},
			{
				before: 1,
				reason:
					"Image couldn't be shown: its PNG header can't be read, so the image is cut short or damaged.",
			},
			{ before: 1, reason: "Image couldn't be shown: its data isn't valid base64." },
		]);
		expect(entry?.tools?.[0]?.result).toBe("Drew five\n6 images");
	});

	it("say how big an image was that the client left out because its result did not fit one message", async () => {
		let large = bigPng(2_400_000);
		let { chat, storage } = await drawn([
			{ type: "text", text: "Drew two" },
			{ type: "image", data: encoded(large), mimeType: "image/png", alt: "Too large" },
			{ type: "image", data: encoded(PNG), mimeType: "image/png", alt: "Fits" },
		]);

		let entry = chat.entries.find(item => item.images);
		expect(entry?.images?.map(image => image.alt)).toEqual(["Fits"]);
		expect(entry?.refusedImages).toEqual([{
			before: 0,
			reason:
				"Image couldn't be shown: it is 2.3 MiB, which did not fit in one agent connection message (2 MiB at most).",
		}]);
		expect(entry?.tools?.[0]?.result).toBe("Drew two\n2 images");
		expect(await storage.images.channels(hashOf(large))).toEqual([]);
	});
});
