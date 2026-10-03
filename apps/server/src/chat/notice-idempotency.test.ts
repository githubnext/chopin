import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Service from "../plan/service";
import { hosted } from "./notice.test-fixtures";

test("a stable notice is committed and broadcast only once across concurrent retries", async () => {
	let context = await hosted();
	let original = context.storage.collaboration.commit;
	let commits = 0;
	context.storage.collaboration.commit = async input => {
		commits++;
		let result = await original(input);
		context.order.push("committed");
		return result;
	};
	let id = "research-complete:request-1";
	let [first, second] = await Promise.all([
		Chat.noticeOnce(context.announcer, id, "Research is ready"),
		Chat.noticeOnce(context.announcer, id, "Research is ready"),
	]);
	expect(second).toBe(first);
	expect(first.id).toBe(id);
	expect(commits).toBe(1);
	expect(context.order).toEqual(["committed", "broadcast:Research is ready"]);
	expect(context.plan.chat.entries).toEqual([first]);
	await Service.close(context.plan);
});

test("a stable notice retry after restart returns its durable entry without publication", async () => {
	let context = await hosted();
	let id = "research-complete:request-2";
	let input = {
		text: "Research is ready",
		decision: { questionnaireId: "document", kind: "activity" as const, label: "Ready" },
	};
	let first = await Chat.noticeOnce(context.announcer, id, input);
	await Service.close(context.plan);
	let restored = await Service.open(context.channel.id, {
		storage: context.storage,
		lease: () => context.lease,
		fatal: () => {},
	}, context.server);
	let announcer = { ...context.announcer, chat: restored.chat, plan: restored };
	context.order.length = 0;
	let retry = await Chat.noticeOnce(announcer, id, input);
	expect(retry).toBe(restored.chat.entries[0]);
	expect(retry).toEqual(first);
	expect(context.order).toEqual([]);
	await Service.close(restored);
});

test("a stable notice rejects divergent content without changing the transcript", async () => {
	let context = await hosted();
	let id = "research-complete:request-3";
	let first = await Chat.noticeOnce(context.announcer, id, "Research is ready");
	context.order.length = 0;
	await expect(Chat.noticeOnce(context.announcer, id, "Research failed"))
		.rejects.toThrow("conflicts with an existing entry");
	await expect(Chat.noticeOnce(context.announcer, id, {
		text: "Research is ready",
		decision: { questionnaireId: "document", kind: "activity" },
	})).rejects.toThrow("conflicts with an existing entry");
	expect(context.plan.chat.entries).toEqual([first]);
	expect(context.order).toEqual([]);
	await Service.close(context.plan);
});

test("a failed stable notice commit can be retried with the same ID", async () => {
	let context = await hosted();
	let original = context.storage.collaboration.commit;
	let attempts = 0;
	context.storage.collaboration.commit = async input => {
		attempts++;
		if (attempts === 1) throw new Error("disk");
		return original(input);
	};
	let id = "research-complete:request-4";
	await expect(Chat.noticeOnce(context.announcer, id, "Research is ready"))
		.rejects.toThrow("disk");
	expect(context.plan.chat.entries).toEqual([]);
	expect(context.order).toEqual([]);
	let entry = await Chat.noticeOnce(context.announcer, id, "Research is ready");
	expect(entry.id).toBe(id);
	expect(context.plan.chat.entries).toEqual([entry]);
	expect(context.order).toEqual(["broadcast:Research is ready"]);
	await Service.close(context.plan);
});
