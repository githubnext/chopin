import { describe, expect, it } from "bun:test";

import * as Chat from "./service";

import type { Server } from "bun";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { Plan } from "../plan/service";
import type { Socket } from "../wire";
import type { SocketData } from "../wire";

type Sent = {
	kind: string;
	id?: string;
	message?: string;
	queued?: boolean;
	rid?: string;
	[key: string]: unknown;
};

function room(options: { agent?: boolean; busy?: boolean } = {}) {
	let sent: Sent[] = [];
	let chat = Chat.create();
	chat.busy = options.busy ?? false;

	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Sent);
		},
	} as unknown as Server<SocketData>;

	let context: Chat.Room = {
		chat,
		config: { agent: options.agent ?? true } as Config,
		plan: { chat } as Plan,
		room: "test",
		server,
		auth: {} as Chat.Room["auth"],
		claimantSessionId: "session",
		repository: { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" },
		persist: async () => {},
	};

	return { chat, context, sent };
}

function sender(handle = "ana", userId = `U_${handle}`, frames: Sent[] = []): Socket {
	return {
		data: {
			handle,
			principalId: userId,
			...(handle.startsWith("demo:") ? { actor: { id: handle } } : {}),
		},
		send(value: string) {
			frames.push(JSON.parse(value) as Sent);
		},
	} as unknown as Socket;
}

function message(
	text: string,
	to: Wire.Destination,
	references?: Wire.ReferenceRequest[],
	rid = "request",
	requestId: string = crypto.randomUUID(),
): Request<Wire.Send> {
	return {
		kind: "chat:send",
		rid,
		requestId,
		text,
		to,
		ts: 0,
		...(references ? { references } : {}),
	};
}

describe("demo actors sharing one operator", () => {
	it("keeps retries and withdrawal apart per actor", async () => {
		let { chat, context } = room({ busy: true });
		let lily = sender("demo:lily", "U_op");
		let felix = sender("demo:felix", "U_op");
		let requestId = crypto.randomUUID();

		await Chat.send(context, lily, message("draft it", "planner", undefined, "a", requestId));
		await Chat.send(context, lily, message("draft it", "planner", undefined, "b", requestId));
		expect(chat.waiting).toHaveLength(1);

		let replies: Sent[] = [];
		let rival = sender("demo:felix", "U_op", replies);
		await Chat.send(context, rival, message("draft it", "planner", undefined, "c", requestId));
		expect(replies[0]).toMatchObject({
			kind: "session:error",
			message: "chat request id was reused with different content",
		});
		expect(chat.waiting).toHaveLength(1);

		Chat.unqueue(context, felix, { kind: "chat:unqueue", rid: "u", id: requestId, ts: 0 });
		expect(chat.waiting).toHaveLength(1);
		Chat.unqueue(context, lily, { kind: "chat:unqueue", rid: "u", id: requestId, ts: 0 });
		expect(chat.waiting).toHaveLength(0);
	});

	it("authors room messages as the admitted actor", async () => {
		let { chat, context } = room();
		let msg = { ...message("hello", "room"), author: { kind: "member", handle: "mallory" } };
		await Chat.send(context, sender("demo:lily", "U_op"), msg);
		expect(chat.entries[0]).toMatchObject({ author: { kind: "member", handle: "demo:lily" } });
	});
});
