import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Chat from "./service";
import * as Service from "../plan/service";
import type { Socket } from "../wire";
import { hosted } from "./notice.test-fixtures";

test("a decision notice commits before broadcasting and restores", async () => {
	let context = await hosted();
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async input => {
		let result = await original(input);
		context.order.push("committed");
		return result;
	};
	let entry = await Chat.notice(context.announcer, {
		text: "Ready to decide: What auth system should we use?",
		decision: { questionnaireId: ulid(), kind: "prompt", generation: 0 },
	});
	expect(context.order).toEqual([
		"committed",
		"broadcast:Ready to decide: What auth system should we use?",
	]);
	expect(entry).toMatchObject({ author: { kind: "system" }, decision: { kind: "prompt" } });
	expect(context.plan.chat.entries.at(-1)).toBe(entry);
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, {
		storage: context.storage,
		lease: () => context.lease,
		fatal: () => {},
	}, context.server);
	expect(restored.chat.entries.at(-1)?.decision).toEqual(entry.decision);
	await Service.close(restored);
});

test("a refreshed notice keeps its ID, commits before broadcast, and rolls back on failure", async () => {
	let context = await hosted();
	let questionnaireId = ulid();
	let first = await Chat.notice(context.announcer, {
		text: "Ready to decide",
		decision: { questionnaireId, kind: "prompt", generation: 0, label: "Initial" },
	});
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async input => {
		let result = await original(input);
		context.order.push("committed");
		return result;
	};
	let refreshed = await Service.exclusive(
		context.plan,
		() =>
			Chat.refreshNoticeExclusive(context.announcer, first.id, {
				text: "Ready to decide",
				decision: { questionnaireId, kind: "prompt", generation: 0, label: "Updated" },
			}),
	);
	expect(refreshed.id).toBe(first.id);
	expect(context.plan.chat.entries).toHaveLength(1);
	expect(context.order.slice(-2)).toEqual(["committed", "broadcast:Ready to decide"]);
	expect(context.frames.at(-1)?.entry?.decision).toEqual(refreshed.decision);

	let broadcasts = context.frames.length;
	context.storage.collaboration.commit = async () => {
		throw new Error("disk");
	};
	await expect(
		Service.exclusive(context.plan, () =>
			Chat.refreshNoticeExclusive(context.announcer, first.id, {
				text: "Ready to decide",
				decision: { questionnaireId, kind: "prompt", generation: 0, label: "Failed" },
			})),
	).rejects.toThrow("disk");
	expect(context.plan.chat.entries[0]).toBe(refreshed);
	expect(context.frames).toHaveLength(broadcasts);
	context.storage.collaboration.commit = original;
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, {
		storage: context.storage,
		lease: () => context.lease,
		fatal: () => {},
	}, context.server);
	expect(restored.chat.entries).toHaveLength(1);
	expect(restored.chat.entries[0]?.decision).toEqual(refreshed.decision);
	await Service.close(restored);
});

test("a failed notice commit cannot be saved by a following transcript write", async () => {
	let context = await hosted();
	let entered: (() => void) | undefined;
	let started = new Promise<void>(resolve => entered = resolve);
	let release: (() => void) | undefined;
	let blocked = new Promise<void>(resolve => release = resolve);
	let original = context.storage.collaboration.commit;
	let first = true;
	context.storage.collaboration.commit = async input => {
		if (first) {
			first = false;
			entered!();
			await blocked;
			throw new Error("disk");
		}
		return original(input);
	};
	let failed = Chat.notice(context.announcer, "failed notice");
	await started;
	let socket = {
		data: { handle: "octocat", principalId: "U_octocat" },
		send() {},
	} as unknown as Socket;
	let later = Chat.send(
		{
			...context.announcer,
			persist: () => Service.persist(context.plan),
		} as Chat.Room,
		socket,
		{
			kind: "chat:send",
			ts: 0,
			rid: "member-send",
			requestId: crypto.randomUUID(),
			text: "Keep this message",
			to: "room",
		},
	);
	await Bun.sleep(0);
	expect(context.plan.chat.entries.map(entry => entry.text)).toEqual([
		"failed notice",
		"Keep this message",
	]);
	release!();
	await expect(failed).rejects.toThrow("disk");
	await later;
	expect(context.plan.chat.entries.map(entry => entry.text)).toEqual(["Keep this message"]);
	expect(context.order).toEqual(["broadcast:Keep this message"]);
	let loaded = await context.storage.collaboration.load(context.channel.id, context.now);
	let sidecar = loaded?.sidecar ?? loaded?.snapshot?.sidecar;
	expect(JSON.stringify(sidecar)).not.toContain("failed notice");
	expect(JSON.stringify(sidecar)).toContain("Keep this message");
	await Service.close(context.plan);
});
