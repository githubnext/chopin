/**
 * Alone in a document, a person is talking to chopin: what they send to the room goes to the
 * Planner, as if it named it, with no wait for silence and no judgment. Once a second person is
 * there, the rules of automatic participation apply as they did.
 */
import { expect, test } from "bun:test";

import * as Chat from "./service";
import { alone, announceAlone, people } from "./initiative";
import { installInitiativeCleanup, message } from "./initiative.test-fixtures";
import { until } from "./job.test-fixtures";

import type { Chat as Wire } from "@chopin/protocol";
import type { Socket } from "../wire";

let setup = installInitiativeCleanup();

type Frame = { kind: string; [key: string]: unknown };

function tab(principalId: string, client: string, canEdit = true): Socket {
	return { data: { principalId, client, canEdit, closed: false } } as unknown as Socket;
}

test("the people in a conversation are its writers and recent speakers, a person's tabs once, readers not", async () => {
	let h = await setup.harness();
	let chat = h.chat;
	expect(people(chat, [tab("U_ana", "ana-1"), tab("U_ana", "ana-2")])).toEqual(new Set(["U_ana"]));
	// Someone who can only read is neither sending nor typing in Chat.
	expect(people(chat, [tab("U_ana", "ana-1"), tab("U_rae", "rae-1", false)]))
		.toEqual(new Set(["U_ana"]));
	// Someone who spoke a moment ago is still in the conversation after closing the tab.
	let bo = { ...h.ws, data: { ...h.ws.data, handle: "bo", principalId: "U_bo", client: "bo-tab" } };
	await Chat.send(h.context, bo as Socket, message("Back in a bit"));
	expect(people(chat, [tab("U_ana", "ana-1")])).toEqual(new Set(["U_ana", "U_bo"]));
});

test("alone, a message to the room starts chopin's turn at once, with no wait and no judgment", async () => {
	let h = await setup.harness();
	h.context.people = () => new Set(["U_ana"]);
	let source = message("What does a decision represent?");
	await Chat.send(h.context, h.ws, source);
	await until(() => h.prompts.length === 1);
	expect(h.judge).not.toHaveBeenCalled();
	expect(h.replies.at(-1)).toMatchObject({ kind: "chat:send", id: source.requestId });
	// Saved, shown and read as a message to chopin, as one that named it would be.
	let shown = h.frames.find(frame => frame.kind === "chat:message")?.entry as Wire.Entry;
	expect(shown).toMatchObject({ id: source.requestId, text: source.text, to: "planner" });
	expect(h.prompts[0]).toContain(`@ana: ${source.text}`);
	expect(h.prompts[0]).not.toContain("one concise final conversational reply");
	expect(h.chat.backscroll).toEqual([]);

	let addressed = await setup.harness();
	await Chat.send(addressed.context, addressed.ws, message(`@chopin ${source.text}`, "planner"));
	await until(() => addressed.prompts.length === 1);
	expect(h.prompts[0]!.replace(source.requestId, "")).toBe(
		addressed.prompts[0]!.replace(addressed.chat.entries[0]!.id, ""),
	);
});

test("with a second person there, a message to the room waits for silence and the judge", async () => {
	let h = await setup.harness();
	h.context.people = () => new Set(["U_ana", "U_bo"]);
	h.judge.mockResolvedValue("respond");
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(1_499);
	expect(h.prompts).toEqual([]);
	expect(h.judge).not.toHaveBeenCalled();
	await h.clock.advance(1);
	await until(() => h.prompts.length === 1);
	expect(h.judge).toHaveBeenCalledTimes(1);
	expect(h.prompts[0]).toContain("one concise final conversational reply");
	let shown = h.frames.find(frame => frame.kind === "chat:message")?.entry as Wire.Entry;
	expect(shown.to).toBeUndefined();
});

test("where automatic participation is off, being alone changes nothing", async () => {
	let h = await setup.harness();
	h.context.people = () => new Set(["U_ana"]);
	h.context.config.agent = false;
	expect(alone(h.context, "U_ana")).toBe(false);
	await Chat.send(h.context, h.ws, message());
	await h.clock.advance(30_000);
	expect(h.prompts).toEqual([]);
	expect(h.judge).not.toHaveBeenCalled();
	expect(h.chat.entries[0]).not.toHaveProperty("to");
	expect((h.chat.entries[0] as { delivery?: { destination: string } }).delivery?.destination)
		.toBe("room");

	let child = await setup.harness();
	child.context.people = () => new Set(["U_ana"]);
	child.context.rootChannelId = "root";
	expect(alone(child.context, "U_ana")).toBe(false);
});

test("alone, a message sent while chopin's turn runs is given to that turn", async () => {
	let h = await setup.harness();
	h.context.people = () => new Set(["U_ana"]);
	await Chat.send(h.context, h.ws, message("Draft the rollout"));
	await until(() => h.prompts.length === 1);
	await Chat.send(h.context, h.ws, message("Keep it short"));
	await until(() => h.steered.length === 1);
	expect(h.steered).toEqual(["@ana: Keep it short"]);
	expect(h.prompts).toHaveLength(1);
	expect(h.judge).not.toHaveBeenCalled();
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	await h.clock.advance(30_000);
	expect(h.prompts).toHaveLength(1);
	expect(h.judge).not.toHaveBeenCalled();
});

test("alone with no machine to take it, a message is refused as one to chopin is", async () => {
	let h = await setup.harness();
	h.context.people = () => new Set(["U_ana"]);
	h.context.plannerNotAttached = async () => "chopin's machine is away.";
	await Chat.send(h.context, h.ws, message());
	expect(h.replies.at(-1)).toMatchObject({
		kind: "session:error",
		message: "chopin's machine is away.",
		code: "planner-not-attached",
	});
	expect(h.chat.entries).toEqual([]);
	await h.clock.advance(30_000);
	expect(h.judge).not.toHaveBeenCalled();
});

test("someone joining while chopin answers leaves that turn running, and their message waits its turn", async () => {
	let h = await setup.harness();
	let present = new Set(["U_ana"]);
	h.context.people = () => present;
	h.judge.mockResolvedValue("respond");
	let first = message("Draft the rollout");
	await Chat.send(h.context, h.ws, first);
	await until(() => h.prompts.length === 1);
	present = new Set(["U_ana", "U_bo"]);
	let bo = { ...h.ws, data: { ...h.ws.data, handle: "bo", principalId: "U_bo", client: "bo-tab" } };
	await Chat.send(h.context, bo as Socket, message("Hi both"));
	// Bo's message is the room's: chopin's turn does not read it, and nothing is aborted.
	await h.clock.advance(5_000);
	expect(h.steered).toEqual([]);
	expect(h.aborts()).toBe(0);
	expect(h.judge).not.toHaveBeenCalled();
	// A resend of the first message is still that message, though ana is no longer alone.
	await Chat.send(h.context, h.ws, { ...first, rid: "delivery-retry" });
	expect(h.replies.at(-1)).toMatchObject({ kind: "chat:send", id: first.requestId });
	expect(h.chat.entries.filter(entry => entry.id === first.requestId)).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	// The turn's end lets automatic participation consider Bo's message, as before.
	await h.clock.advance(1_000);
	await until(() => h.judge.mock.calls.length === 1);
});

test("Chat is told when its conversation comes to hold one person, or more, and only then", async () => {
	let h = await setup.harness();
	h.chat.initiativeEnabled = true;
	let server = h.context.server;
	announceAlone(h.chat, server, "room", new Set(["U_ana"]));
	announceAlone(h.chat, server, "room", new Set(["U_ana"]));
	announceAlone(h.chat, server, "room", new Set(["U_ana", "U_bo"]));
	announceAlone(h.chat, server, "room", new Set());
	let told = (h.frames as Frame[]).filter(frame => frame.kind === "chat:participation");
	expect(told.map(frame => frame.alone ?? false)).toEqual([true, false, true]);

	let off = await setup.harness();
	off.chat.initiativeEnabled = false;
	announceAlone(off.chat, off.context.server, "room", new Set(["U_ana"]));
	expect((off.frames as Frame[]).filter(frame => frame.kind === "chat:participation"))
		.toEqual([]);
});
