import { expect, test } from "bun:test";

import { publishPlannerReplies } from "./reply-policy";
import { create, translate } from "./service";

import type { Server } from "bun";
import type { TextStreamPart, ToolSet } from "ai";
import type { Chat } from "@chopin/protocol";
import type { Room } from "./service";
import type { SocketData } from "../wire";

test("a complete checked reply reaches Chat through its message without depending on delta count", async () => {
	let checked = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let frames: Chat.Outgoing[] = [];
	let context = {
		chat: create(),
		room: "reply-projection",
		server: {
			publish(_topic: string, raw: string) {
				frames.push(JSON.parse(raw));
			},
		} as unknown as Server<SocketData>,
	} as Room;
	let parts: TextStreamPart<ToolSet>[] = [
		{ type: "text-start", id: "reply" },
		{ type: "text-delta", id: "reply", text: "Plan: " },
		{ type: "text-delta", id: "reply", text: "Harness parent." },
		{ type: "text-end", id: "reply" },
	];
	let pending = publishPlannerReplies({
		session: {
			async stream() {
				return {
					fullStream: (async function*() {
						yield* parts;
					})(),
				} as never;
			},
		},
		prompt: "Read the document.",
		signal: new AbortController().signal,
		decide: async request => {
			expect(request.state).toEqual({ reply: "Plan: Harness parent." });
			checked.resolve();
			await release.promise;
			return {
				model: "projection-test",
				answers: { input: { type: "noul", noul: 0 } },
				usage: { input_tokens: 0, output_tokens: 0 },
				latencyMs: 0,
			};
		},
		publish: part => translate(context, part),
	});
	await checked.promise;
	expect(frames).toHaveLength(0);
	release.resolve();
	await pending;
	let messages = frames.filter(frame => frame.kind === "chat:message");
	expect(messages[0]?.entry.text).toBe("Plan: Harness parent.");
	expect(messages.at(-1)?.entry).toMatchObject({ text: "Plan: Harness parent." });
	expect(messages.at(-1)?.entry.streaming).toBeUndefined();
	expect(context.chat.entries.at(-1)?.text).toBe("Plan: Harness parent.");
});
