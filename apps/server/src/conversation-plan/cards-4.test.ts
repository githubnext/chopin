import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import { cardEffects } from "./cards";
import { runEffects } from "./effects";

import * as Questions from "../questions/service";
import * as Store from "../questions/store";

import { openPlan } from "../testing/plan";

import type { Processor } from "./service";
import { CARD, plans, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a full card is terminal and does not block a later quoted option", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let full = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "full-thread",
		header: "Full",
		question: "Which?",
		options: Array.from({ length: 10 }, (_, index) => ({
			id: ulid(),
			label: `Choice ${index}`,
		})),
	});
	let open = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "open-thread",
		header: "Open",
		question: "Which?",
		options: [],
	});
	context.plan.conversationPlan.threads = [
		{ ...thread(), id: "full-thread", questionnaireId: full, contributions: [] },
		{ ...thread(), id: "open-thread", questionnaireId: open, contributions: [] },
	];
	let accepted = new Set<string>();
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	let first = ulid();
	let second = ulid();
	let completed = await runEffects({
		...commands,
		applied: key => accepted.has(key),
		markApplied: async key => {
			accepted.add(key);
		},
	}, [
		{
			key: `option:${first}`,
			kind: "add-option",
			threadId: "full-thread",
			optionId: first,
			label: "Too many",
			trigger: "m1",
		},
		{
			key: `option:${second}`,
			kind: "add-option",
			threadId: "open-thread",
			optionId: second,
			label: "GitHub Apps",
			trigger: "m2",
		},
	]);
	expect(completed).toBe(2);
	expect(accepted).toEqual(new Set([`option:${first}`, `option:${second}`]));
	expect(context.plan.records.get(full)!.definition.questions[0]!.options).toHaveLength(10);
	expect(context.plan.records.get(open)!.definition.questions[0]!.options).toMatchObject([{
		id: second,
		label: "GitHub Apps",
	}]);
	expect(context.plan.pendingCardActions).toEqual([]);
	let record = context.plan.records.get(open)!;
	context.plan.records.set(open, {
		...record,
		definition: {
			questions: [{
				...record.definition.questions[0]!,
				options: [{ ...record.definition.questions[0]!.options[0]!, label: "Refined" }],
			}],
		},
	});
	await commands.addOption(open, { optionId: second, label: "GitHub Apps" });
	expect(context.plan.records.get(open)!.definition.questions[0]!.options[0]!.label)
		.toBe("Refined");
	context.plan.execution = { id: "run-1" } as never;
	await expect(commands.addOption(open, { optionId: ulid(), label: "Deferred" }))
		.rejects.toThrow("implementation is active");
	context.plan.execution = undefined;
	expect(Store.reserveEdit(context.plan.questions, open)).toBe(true);
	await expect(commands.addOption(open, { optionId: ulid(), label: "Busy" }))
		.rejects.toThrow("temporarily unavailable");
	Store.releaseEdit(context.plan.questions, open);
});

test("closed-card prose readiness requires the linked thread and saved generation", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
		threadId: "thread-a",
		header: "Decision",
		question: "Which?",
		options: [],
	});
	let record = context.plan.records.get(id)!;
	context.plan.records.set(id, {
		...record,
		status: "answered",
		owner: "ana",
		decidedAt: 1,
	} as never);
	context.plan.conversationPlan.threads = [{ ...thread(), questionnaireId: id }];
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	expect(commands.proseReady?.("thread-a", id, `decided:${id}:1`)).toBe(true);
	expect(commands.proseReady?.("other-thread", id, `decided:${id}:1`)).toBe(false);
	expect(commands.proseReady?.("thread-a", "other-card", `decided:${id}:1`)).toBe(false);
	expect(commands.proseReady?.("thread-a", id, `decided:${id}:2`)).toBe(false);
});

test("a linked but missing card defers insertion instead of creating a second card", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	context.plan.conversationPlan.threads = [{
		...thread(),
		id: "missing-thread",
		questionnaireId: CARD,
	}];
	let commands = cardEffects(
		context.plan,
		context.server,
		"test",
		{ record: async () => true } as unknown as Processor,
		undefined,
		{ chat: context.plan.chat, plan: context.plan, server: context.server, room: "test" },
	);
	await expect(commands.insertCard({
		threadId: "missing-thread",
		header: "Auth",
		question: "Which?",
		options: [],
	})).rejects.toThrow("linked card is missing");
	expect(context.plan.records.size).toBe(0);
});
