import { expect, test } from "bun:test";
import * as Chat from "./service";
import { harness, installJobCleanup, member, socket, until } from "./job.test-fixtures";

installJobCleanup();

test("saved member hooks exclude retries and failed room or immediate Planner saves", async () => {
	let h = harness();
	let saved: string[] = [];
	h.context.memberMessagePersisted = entry => saved.push(entry.id);
	let room = { ...member("Coworker topic"), to: "room" as const };
	await Chat.send(h.context, socket(), room);
	await Chat.send(h.context, socket(), { ...room, rid: "retry" });
	expect(saved).toEqual([room.requestId]);
	h.context.persist = async () => {
		throw new Error("save failed");
	};
	await Chat.send(h.context, socket(), { ...member("Failed room"), to: "room" });
	await Chat.send(h.context, socket(), member("Failed Planner"));
	expect(saved).toEqual([room.requestId]);
	expect(h.chat.entries.map(entry => entry.id)).toEqual([room.requestId]);
});

test("queued browser messages schedule once after their save with the queued sender", async () => {
	let h = harness();
	let first = member("First turn");
	let second = member("Queued topic");
	let saved: Array<{ id: string; claimant?: string }> = [];
	h.context.memberMessagePersisted = (entry, claimant) => saved.push({ id: entry.id, claimant });
	await Chat.send(h.context, socket(), first);
	await until(() => h.prompts.length === 1);
	await Chat.send({ ...h.context, claimantSessionId: "second-session" }, socket(), second);
	await Chat.send(h.context, socket(), { ...second, rid: "retry" });
	expect(saved).toEqual([{ id: first.requestId, claimant: "session" }]);
	expect(h.chat.entries.some(entry => entry.id === second.requestId)).toBe(false);
	h.emit("session.idle");
	await until(() => h.prompts.length === 2);
	expect(saved).toEqual([
		{ id: first.requestId, claimant: "session" },
		{ id: second.requestId, claimant: "second-session" },
	]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("a failed queued save creates no saved-member trigger", async () => {
	let h = harness();
	let saved: string[] = [];
	h.context.memberMessagePersisted = entry => saved.push(entry.id);
	let first = member("First turn");
	let second = member("Queued topic");
	await Chat.send(h.context, socket(), first);
	await until(() => h.prompts.length === 1);
	await Chat.send(h.context, socket(), second);
	h.context.persist = async () => {
		if (h.chat.entries.some(entry => entry.id === second.requestId)) {
			throw new Error("drain save failed");
		}
	};
	h.emit("session.idle");
	await until(() => h.chat.closed);
	expect(saved).toEqual([first.requestId]);
	expect(h.prompts).toHaveLength(1);
});

test("invoke reserves or queues its human turn before scheduling and never schedules at drain again", async () => {
	let h = harness();
	let saved: string[] = [];
	h.context.memberMessagePersisted = entry => {
		expect(h.chat.busy).toBe(true);
		saved.push(entry.id);
	};
	expect(await Chat.invoke(h.context, { id: "U_ana", login: "ana" }, "First invocation"))
		.toBeUndefined();
	await until(() => h.prompts.length === 1);
	expect(await Chat.invoke(h.context, { id: "U_bo", login: "bo" }, "Queued invocation"))
		.toBeUndefined();
	expect(saved).toHaveLength(2);
	h.emit("session.idle");
	await until(() => h.prompts.length === 2);
	expect(saved).toHaveLength(2);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});
