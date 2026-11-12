/**
 * A failed reply is retried on the same message: Chat keeps one message, the failed attempt leaves
 * the transcript before anyone is told, and the agent is given the message once and nothing of
 * the attempt.
 */
import { expect, test } from "bun:test";

import * as Chat from "./service";
import { retryTarget } from "./retry";
import { harness, installJobCleanup, member, until } from "./job.test-fixtures";

import type { Chat as Wire, Request } from "@chopin/protocol";
import type { PlannerTurnMessage } from "../harness/session";
import type { Socket } from "../wire";

installJobCleanup();

type Frame = { kind: string; [key: string]: unknown };

function speaking(handle: string, frames: Frame[] = []): Socket {
	return {
		data: { handle, principalId: `U_${handle}` },
		send: (raw: string) => frames.push(JSON.parse(raw) as Frame),
	} as unknown as Socket;
}

function retrying(message: string): Request<Wire.Retry> {
	return { kind: "chat:retry", rid: crypto.randomUUID(), ts: 0, message };
}

/** A harness whose turns record what their agent is given: instructions, prompt and message. */
function recording() {
	let h = harness();
	let given: Array<{ instructions: string; prompt: string; message?: PlannerTurnMessage }> = [];
	// Every reply passes the reply check.
	h.context.decide = (async () => ({ answers: { input: { type: "noul", noul: 0 } } })) as never;
	h.context.openPlannerSession = async (_binding, channel) => {
		let session = h.session();
		let instructions = typeof channel.instructions === "function"
			? channel.instructions()
			: channel.instructions;
		return {
			ok: true,
			value: {
				...session,
				stream: (prompt, signal, choice, files, message) => {
					given.push({ instructions, prompt, ...(message ? { message } : {}) });
					return session.stream(prompt, signal, choice, files, message);
				},
			},
		};
	};
	return { ...h, given };
}

/** Sends `text` as ana and fails its turn after a partial reply. */
async function failedTurn(h: ReturnType<typeof recording>, text: string, words: string) {
	let ask = member(`@chopin ${text}`);
	await Chat.send(h.context, speaking("ana"), ask);
	await until(() => h.prompts.length > 0);
	let count = h.prompts.length;
	h.emit("assistant.message_delta", { messageId: `m${count}`, deltaContent: "Partial draft." });
	h.emit("assistant.message", { messageId: `m${count}` });
	await until(() => h.chat.entries.some(entry => entry.text === "Partial draft."));
	h.emit("session.error", { message: words });
	await until(() => !h.chat.busy);
	return ask;
}

test("Retry runs the same message's turn again: one message, the failed attempt gone, the agent given the message once", async () => {
	let h = recording();
	await Chat.send(h.context, speaking("bo"), { ...member("the room's earlier note"), to: "room" });
	let ask = await failedTurn(h, "hello there", "503 Service Unavailable");
	expect(h.chat.entries.map(entry => entry.author.kind)).toEqual([
		"member",
		"member",
		"agent",
		"system",
	]);
	let failed = h.chat.entries.map(entry => entry.id).slice(2);
	expect(h.given[0]!.message).toEqual({ id: ask.requestId });

	let frames: Frame[] = [];
	h.frames.length = 0;
	await Chat.retry(h.context, speaking("ana", frames), retrying(ask.requestId));
	expect(frames).toEqual([
		expect.objectContaining({ kind: "chat:retry", message: ask.requestId }),
	]);
	// Saved without the attempt, and the room told which entries went.
	expect(h.chat.entries.map(entry => entry.id).slice(1)).toEqual([ask.requestId]);
	expect(h.frames).toContainEqual(expect.objectContaining({ kind: "chat:removed", ids: failed }));
	expect(h.frames.filter(frame => frame.kind === "chat:message")).toEqual([]);

	await until(() => h.given.length === 2);
	let retried = h.given[1]!;
	expect(retried.message).toEqual({ id: ask.requestId, retry: true });
	let context = `${retried.instructions}\n${retried.prompt}`;
	// What the room said before is still the turn's context; only the attempt is gone.
	expect(context).toContain("the room's earlier note");
	expect(context.split("hello there")).toHaveLength(2);
	expect(context).not.toContain("Partial draft.");
	expect(context).not.toContain("503 Service Unavailable");

	h.emit("assistant.message_delta", { messageId: "m9", deltaContent: "Hello, ana." });
	h.emit("assistant.message", { messageId: "m9" });
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(h.chat.entries.map(entry => [entry.author.kind, entry.text])).toEqual([
		["member", "the room's earlier note"],
		["member", "hello there"],
		["agent", "Hello, ana."],
	]);
});

test("a Retry that fails again leaves one failure, the new one, after the same message", async () => {
	let h = recording();
	let ask = await failedTurn(h, "outline it", "503 (attempt 1)");
	await Chat.retry(h.context, speaking("ana"), retrying(ask.requestId));
	await until(() => h.given.length === 2);
	h.emit("assistant.message_delta", { messageId: "m2", deltaContent: "Partial draft." });
	h.emit("assistant.message", { messageId: "m2" });
	await until(() => h.chat.entries.some(entry => entry.text === "Partial draft."));
	h.emit("session.error", { message: "503 (attempt 2)" });
	await until(() => !h.chat.busy);
	expect(h.chat.entries.map(entry => [entry.author.kind, entry.text])).toEqual([
		["member", "outline it"],
		["agent", "Partial draft."],
		["system", "503 (attempt 2)"],
	]);
	expect(h.chat.entries[2]!.turnFailure).toMatchObject({ kind: "error", request: ask.requestId });
});

test("only the sender may retry, only the latest failure, and nothing changes when it is refused", async () => {
	let h = recording();
	let ask = await failedTurn(h, "draft it", "503");
	let before = [...h.chat.entries];

	let theirs: Frame[] = [];
	await Chat.retry(h.context, speaking("bo"), retrying(ask.requestId));
	await Chat.retry(h.context, speaking("bo", theirs), retrying(ask.requestId));
	expect(theirs).toEqual([expect.objectContaining({ kind: "session:error" })]);
	expect(String(theirs[0]!.message)).toContain("only the person who sent the message");

	let unknown: Frame[] = [];
	await Chat.retry(h.context, speaking("ana", unknown), retrying("nothing"));
	expect(unknown).toEqual([expect.objectContaining({ kind: "session:error" })]);
	expect(h.chat.entries).toEqual(before);
	expect(h.chat.busy).toBe(false);
	expect(h.given).toHaveLength(1);
});

test("the failed attempt is what the agent wrote between the message and its failure; what members said stays", () => {
	let ask: Wire.Entry = {
		id: "ask",
		author: { kind: "member", handle: "Ana" },
		text: "plan it",
		ts: 1,
		to: "planner",
	};
	let entries: Wire.Entry[] = [
		{ id: "earlier", author: { kind: "agent" }, text: "Earlier reply.", ts: 0 },
		ask,
		{ id: "partial", author: { kind: "agent" }, text: "Partial.", ts: 2 },
		{ id: "room", author: { kind: "member", handle: "bo" }, text: "fyi", ts: 2 },
		{ id: "tools", author: { kind: "agent" }, text: "", ts: 2, tools: [] },
		{
			id: "failure",
			author: { kind: "system" },
			text: "503",
			ts: 3,
			turnFailure: { kind: "error", request: "ask" },
		},
		{ id: "after", author: { kind: "member", handle: "bo" }, text: "oh no", ts: 4 },
	];
	expect(retryTarget(entries, "ask", "ana")).toMatchObject({
		request: { id: "ask" },
		removed: ["partial", "tools", "failure"],
	});
	// A later Planner turn, or a failure asking again cannot help, has nothing to retry.
	expect(retryTarget([...entries, { ...ask, id: "next" }], "ask", "ana")).toHaveProperty("refusal");
	expect(
		retryTarget(
			entries.map(entry =>
				entry.id === "failure"
					? { ...entry, turnFailure: { kind: "refused", request: "ask" } }
					: entry
			),
			"ask",
			"ana",
		),
	).toHaveProperty("refusal");
	// A message that was not to the Planner, or a failure that names another message.
	expect(retryTarget(entries, "room", "bo")).toHaveProperty("refusal");
	expect(retryTarget(entries, "earlier", "ana")).toHaveProperty("refusal");
});
