import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";

import { create, documentRoom } from "./service";

import type { Server } from "bun";
import type { Chat, Room } from "./service";
import type { NewDocumentArguments, NewDocumentRequest } from "../agent/new-documents";
import type { SocketData } from "../wire";

let draft: NewDocumentArguments = {
	idempotencyKey: "settings-page",
	title: "Settings page",
	brief: {
		goal: "Add the settings page.",
		constraints: [],
		settledDecisions: [],
		openQuestions: [],
		repositoryFindings: [],
	},
	document: "# Settings page\n",
};

function room(options: { member?: boolean; persist?: () => Promise<void> } = {}) {
	let chat: Chat = create();
	let frames: Array<Record<string, unknown>> = [];
	let requests: Array<Omit<NewDocumentRequest, "sourceId">> = [];
	let order: string[] = [];
	let server = {
		publish(_topic: string, data: string) {
			let frame = JSON.parse(data) as Record<string, unknown>;
			frames.push(frame);
			order.push(`published:${String(frame.kind)}`);
		},
	} as unknown as Server<SocketData>;
	let context = {
		chat,
		server,
		room: "doc",
		plan: {},
		config: {},
		persist: options.persist ?? (async () => {
			order.push("persisted");
		}),
		createDocument: async (request: Omit<NewDocumentRequest, "sourceId">) => {
			requests.push(request);
			await request.announce({
				id: "0f5b2c1e-8d3a-5b6f-9a21-7c4e5d6f7a8b",
				title: "Settings page",
				path: "/documents/octo/app/settings-page",
			});
			return {
				ok: true as const,
				document: {
					id: "0f5b2c1e-8d3a-5b6f-9a21-7c4e5d6f7a8b",
					title: "Settings page",
					url: "https://chopin.test/documents/octo/app/settings-page",
				},
				next: "done",
			};
		},
	} as unknown as Room;
	chat.busy = true;
	chat.turnController = new AbortController();
	let entryId = ulid();
	chat.entries.push({
		id: entryId,
		author: { kind: "member", handle: "ana" },
		text: "Split this into one document per feature",
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
	if (options.member !== false) {
		chat.activeRequest = {
			entryId,
			userId: "U_ana",
			handle: "ana",
			text: "Split this into one document per feature",
			claimantSessionId: "session-ana",
			turnId: "turn-1",
			lifecycle: chat.lifecycle,
		};
	}
	return { chat, context, frames, requests, order };
}

describe("a Planner turn creating a document", () => {
	it("acts for the person whose message drives the turn and saves the Chat line before showing it", async () => {
		let { chat, context, frames, requests, order } = room();
		let result = await documentRoom(context).createDocument!(draft);
		expect(result).toMatchObject({ ok: true });
		expect(requests).toMatchObject([{
			creator: { userId: "U_ana", handle: "ana", claimantSessionId: "session-ana" },
			arguments: draft,
		}]);
		let line = chat.entries.at(-1)!;
		expect(line).toMatchObject({
			author: { kind: "system" },
			text: "chopin created Settings page for @ana.",
			document: {
				channelId: "0f5b2c1e-8d3a-5b6f-9a21-7c4e5d6f7a8b",
				title: "Settings page",
				path: "/documents/octo/app/settings-page",
			},
		});
		expect(order).toEqual(["persisted", "published:chat:message"]);
		expect(frames.at(-1)).toMatchObject({ kind: "chat:message", entry: { id: line.id } });
	});

	it("is refused in a turn nobody typed", async () => {
		let { context, requests } = room({ member: false });
		expect(await documentRoom(context).createDocument!(draft)).toMatchObject({
			ok: false,
			reason: "member-request-required",
		});
		expect(requests).toEqual([]);
	});

	it("is not offered to a background job", () => {
		let { chat, context } = room();
		chat.job = { id: "job", kind: "heading", status: "running" } as never;
		expect(documentRoom(context).createDocument).toBeUndefined();
	});

	it("posts a line a failed save left out when the call is retried, and never a second", async () => {
		let saves = 0;
		let { chat, context, frames } = room({
			persist: async () => {
				if (saves++ === 0) throw new Error("storage is down");
			},
		});
		let tools = documentRoom(context);
		await expect(tools.createDocument!(draft)).rejects.toThrow("storage is down");
		expect(chat.entries.some(entry => entry.document)).toBe(false);
		await tools.createDocument!(draft);
		await tools.createDocument!(draft);
		expect(chat.entries.filter(entry => entry.document)).toHaveLength(1);
		expect(frames.filter(frame => frame.kind === "chat:message")).toHaveLength(1);
		expect(saves).toBe(2);
	});

	it("shows no Chat line that could not be saved", async () => {
		let { chat, context, frames } = room({
			persist: async () => {
				throw new Error("storage is down");
			},
		});
		await expect(documentRoom(context).createDocument!(draft)).rejects.toThrow("storage is down");
		expect(chat.entries.some(entry => entry.document)).toBe(false);
		expect(frames).toEqual([]);
	});
});
