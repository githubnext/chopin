import { afterEach, beforeEach, spyOn } from "bun:test";
import * as Chat from "./service";
import { harness as currentHarness } from "./job-harness.test-fixtures";
import type { Chat as Wire, ConversationPlan, Request } from "@chopin/protocol";
import type { Socket } from "../wire";

export const JOB: ConversationPlan.Job = {
	id: "refine:W1:m1",
	kind: "refine",
	target: "W1",
	trigger: "m1",
	status: "running",
	attempts: 0,
	at: "2026-09-25T10:00:00.000Z",
};

let chats: Chat.Chat[] = [];
let errors: ReturnType<typeof spyOn> | undefined;

export function installJobCleanup(): void {
	beforeEach(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (let chat of chats) await Chat.close(chat);
		chats = [];
		errors?.mockRestore();
		errors = undefined;
	});
}

export async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition did not become true");
}

export function member(text: string): Request<Wire.Send> {
	return {
		kind: "chat:send",
		rid: crypto.randomUUID(),
		requestId: crypto.randomUUID(),
		to: "planner",
		text,
		ts: 0,
	};
}

export function socket(): Socket {
	return { data: { handle: "ana", principalId: "U_ana" }, send() {} } as unknown as Socket;
}

export function harness(agent = true) {
	return currentHarness(agent, chats);
}
