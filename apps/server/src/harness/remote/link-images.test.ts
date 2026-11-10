import { afterEach, describe, expect, it } from "bun:test";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { ulid } from "@chopin/dialect";

import { create, translate } from "../../chat/service";
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

describe("images over the agent connection", () => {
	it("reach Chat as stored image parts when a client's tool result carries image blocks", async () => {
		let { auth, storage, channel } = await linkAuth();
		let server = linkServer(auth, 300);
		cleanups.push(server.stop);
		let script = scriptedPlanner();
		let content: Array<Record<string, string>> = [
			{ type: "text", text: "Drew the floor plan" },
			{
				type: "image",
				data: Buffer.from(PNG).toString("base64"),
				mimeType: "image/png",
				alt: "Ground floor",
				caption: "Draft one",
			},
			{ type: "image", data: Buffer.from(SVG).toString("base64"), mimeType: "image/svg+xml" },
		];
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
});
