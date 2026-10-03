import * as Chat from "./service";
import { jobStream } from "./job-stream.test-fixtures";

export function harness(agent = true, chats: Chat.Chat[]) {
	let chat = Chat.create();
	chats.push(chat);
	let stream = jobStream();
	let frames: Array<Record<string, unknown>> = [];
	let brokenFrame: string | undefined;
	let ownerAvailable = true;
	let expiresAt = new Date(Date.now() + 60 * 60 * 1000);
	let owner = { access: { token: "gho_test", revision: 1, expiresAt }, session: { expiresAt } };
	let repository = { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" };
	let context = {
		chat,
		plan: { chat },
		server: {
			publish(_topic: string, body: string) {
				let frame = JSON.parse(body) as Record<string, unknown>;
				if (frame.kind === brokenFrame) throw new Error("socket broadcast failed");
				frames.push(frame);
			},
		},
		room: "room",
		config: { agent },
		claimantSessionId: "session",
		repository,
		persist: async () => {},
		activeOwner: async () => ({
			ownerSessionId: "session",
			ownerGeneration: 1,
			credentialRevision: 1,
			repository,
			signal: new AbortController().signal,
			revalidate: async () => true,
			release() {},
		}),
		openPlannerSession: async () => ({ ok: true, value: stream.session() }),
		auth: {
			storage: {
				channels: {
					claimAgentOwner: async () => ({
						ownerSessionId: ownerAvailable ? "session" : undefined,
						generation: 1,
						summary: "",
						transcriptCursor: 0,
					}),
					updateAgentContext: async () => {},
				},
			},
			sessions: {
				resolve: async () => owner,
				use: async () => ({
					authenticated: owner,
					value: { ...repository, permissions: { push: true, admin: false } },
				}),
			},
		},
	} as unknown as Chat.Room;
	return {
		chat,
		context,
		frames,
		...stream,
		breakFrame: (kind: string) => brokenFrame = kind,
		setOwnerAvailable: (value: boolean) => ownerAvailable = value,
	};
}
