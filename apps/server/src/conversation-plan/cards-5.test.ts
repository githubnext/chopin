import { expect, test } from "bun:test";

import { cardEffects } from "./cards";
import { type Effect, runEffects } from "./effects";

import * as Questions from "../questions/service";

import { openPlan } from "../testing/plan";

import type { Processor } from "./service";
import { OPTION, plans, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a delayed old agreement cannot become a fresh prompt after Save and Reopen", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	context.plan.conversationPlan.threads = [{ ...thread(), questionnaireId: id }];
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let receipts = new Set<string>();
	let deps = {
		...commands,
		applied: (key: string) => receipts.has(key),
		markApplied: async (key: string) => void receipts.add(key),
	};
	let effect = (name: string, generation: number): Effect => ({
		key: `prompt:${name}`,
		kind: "prompt",
		threadId: "thread-a",
		optionId: OPTION,
		messageId: name,
		generation,
	});
	expect(await runEffects(deps, [effect("first", 0)])).toBe(1);
	expect(context.plan.chat.entries.map(entry => entry.decision?.generation)).toEqual([0]);
	let ws = {
		data: { handle: "ana", client: "client", room: "test" },
		send() {},
		publish() {},
	} as never;
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	await Questions.reopen(context.plan, context.server, "test", ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});
	expect(context.plan.records.get(id)).toMatchObject({ status: "reopened", history: [{}] });
	expect(await runEffects(deps, [effect("delayed-old", 0)])).toBe(1);
	expect(context.plan.chat.entries.map(entry => entry.decision?.generation)).toEqual([0]);
	expect(await runEffects(deps, [effect("fresh", 1)])).toBe(1);
	expect(context.plan.chat.entries.map(entry => entry.decision?.generation)).toEqual([0, 1]);
});

test("failed prompt persistence and receipt retry produce one durable notice", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Auth",
		question: "Which auth system?",
		options: [{ id: OPTION, label: "GitHub Apps" }],
	});
	context.plan.conversationPlan.threads = [{ ...thread(), questionnaireId: id }];
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let original = context.storage.collaboration.commit;
	let failCommit = true;
	context.storage.collaboration.commit = async input => {
		if (failCommit) {
			failCommit = false;
			throw new Error("storage unavailable");
		}
		return original(input);
	};
	let receipts = new Set<string>();
	let errors: unknown[] = [];
	let failReceipt = true;
	let deps = {
		...commands,
		applied: (key: string) => receipts.has(key),
		markApplied: async (key: string) => {
			if (failReceipt && context.plan.chat.entries.length) {
				failReceipt = false;
				throw new Error("receipt unavailable");
			}
			receipts.add(key);
		},
		report: (error: unknown) => errors.push(error),
	};
	let prompt: Effect = {
		key: "prompt:agreement",
		kind: "prompt",
		threadId: "thread-a",
		optionId: OPTION,
		messageId: "agreement",
		generation: 0,
	};
	expect(await runEffects(deps, [prompt])).toBe(0);
	expect(context.plan.chat.entries).toEqual([]);
	expect(receipts.size).toBe(0);
	expect(await runEffects(deps, [prompt])).toBe(0);
	expect(context.plan.chat.entries).toHaveLength(1);
	expect(receipts.size).toBe(0);
	expect(await runEffects(deps, [prompt])).toBe(1);
	expect(context.plan.chat.entries).toHaveLength(1);
	expect(context.plan.chat.entries[0]?.decision).toMatchObject({
		questionnaireId: id,
		kind: "prompt",
		generation: 0,
	});
	expect(receipts).toEqual(new Set(["prompt:agreement"]));
	expect(errors.map(String)).toEqual(["Error: storage unavailable", "Error: receipt unavailable"]);
});
