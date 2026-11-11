import { MemoryStorage } from "../storage/memory/adapter";
import * as Chat from "./service";
import { harness, member } from "./job.test-fixtures";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { PlannerFiles } from "../harness/session";
import type { Socket } from "../wire";

export const NOW = new Date("2026-10-09T12:00:00.000Z");
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
export const LIMITS = { maxBytes: 64, maxCount: 2, maxTotalBytes: 96 };

export type Failure = { kind: string; message: string; code?: string };

/** A room whose files are kept in real storage, and a Planner session that records what it is given. */
export async function setup(
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
