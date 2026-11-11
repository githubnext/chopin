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

test("browser messages sent while a turn runs schedule once after their save with their sender", async () => {
	let h = harness();
	let first = member("First turn");
	let second = member("Topic for the running turn");
	let saved: Array<{ id: string; claimant?: string }> = [];
	h.context.memberMessagePersisted = (entry, claimant) => saved.push({ id: entry.id, claimant });
	await Chat.send(h.context, socket(), first);
	await until(() => h.prompts.length === 1);
	await Chat.send({ ...h.context, claimantSessionId: "second-session" }, socket(), second);
	await Chat.send(h.context, socket(), { ...second, rid: "retry" });
	await until(() => h.steered.length === 1);
	expect(saved).toEqual([
		{ id: first.requestId, claimant: "session" },
		{ id: second.requestId, claimant: "second-session" },
	]);
	expect(h.steered).toEqual(["@ana: Topic for the running turn"]);
	expect(h.chat.entries.filter(entry => entry.id === second.requestId)).toHaveLength(1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(saved).toHaveLength(2);
	expect(h.prompts).toHaveLength(1);
});

test("a message sent while a turn runs that cannot be saved creates no saved-member trigger", async () => {
	let h = harness();
	let saved: string[] = [];
	h.context.memberMessagePersisted = entry => saved.push(entry.id);
	let first = member("First turn");
	let second = member("Topic for the running turn");
	await Chat.send(h.context, socket(), first);
	await until(() => h.prompts.length === 1);
	h.context.persist = async () => {
		throw new Error("save failed");
	};
	await Chat.send(h.context, socket(), second);
	expect(saved).toEqual([first.requestId]);
	expect(h.chat.entries.map(entry => entry.id)).toEqual([first.requestId]);
	expect(h.steered).toEqual([]);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
});

test("invoke reserves its human turn before scheduling, and a message given to a running turn schedules once", async () => {
	let h = harness();
	let saved: string[] = [];
	h.context.memberMessagePersisted = entry => {
		expect(h.chat.busy).toBe(true);
		saved.push(entry.id);
	};
	expect(await Chat.invoke(h.context, { id: "U_ana", login: "ana" }, "First invocation"))
		.toBeUndefined();
	await until(() => h.prompts.length === 1);
	expect(
		await Chat.invoke(h.context, { id: "U_bo", login: "bo" }, "Invocation for the running turn"),
	)
		.toBeUndefined();
	expect(saved).toHaveLength(2);
	await until(() => h.steered.length === 1);
	h.emit("session.idle");
	await until(() => !h.chat.busy);
	expect(saved).toHaveLength(2);
	expect(h.prompts).toHaveLength(1);
});
