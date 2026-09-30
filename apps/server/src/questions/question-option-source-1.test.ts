import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Questions from "./service";
import * as Service from "../plan/service";
import { applyEvent } from "../conversation-plan/events";
import { initialState } from "../conversation-plan/domain";
import { openPlan } from "../testing/plan";
import { createSourceFixture } from "./question-option-source.test-fixtures";
let plans: Service.Plan[];
let fixture = createSourceFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION_A, OPTION_B, ref, conversationCard } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
test("question source matching requires the exact saved mention on the card thread", () => {
	let source = ref("message-a", "Which authentication provider?");
	let thread = {
		id: "thread-a",
		questionSources: [source],
	} as ConversationPlan.Thread;
	expect(Questions.matchesQuestionSource(source, thread)).toBe(true);
	expect(Questions.matchesQuestionSource({ ...source, messageId: "message-b" }, thread))
		.toBe(false);
	expect(Questions.matchesQuestionSource({ ...source, quote: "Another question?" }, thread))
		.toBe(false);
	expect(
		Questions.matchesQuestionSource(
			{ ...source, author: { kind: "member", handle: "lee" } },
			thread,
		),
	)
		.toBe(false);
	expect(Questions.matchesQuestionSource({ ...source, role: "reason" }, thread)).toBe(false);
	expect(Questions.matchesQuestionSource(source, undefined)).toBe(false);
});

test("question mentions can source alternatives, persist exactly, and carry no stance", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let question = "Should we use GitHub Apps or OAuth?";
	let { id, questionSource } = await conversationCard(context, "thread-a", question);
	for (
		let [optionId, label] of [
			[OPTION_A, "GitHub Apps"],
			[OPTION_B, "OAuth"],
		] as const
	) {
		expect(
			await Questions.addServerOption(context.plan, context.server, "test", id, {
				optionId,
				label,
				origin: "planner",
				source: questionSource,
			}),
		).toEqual({ ok: true, optionId });
	}
	expect(context.plan.records.get(id)!.optionOrigins).toEqual({
		[OPTION_A]: { origin: "planner", source: questionSource },
		[OPTION_B]: { origin: "planner", source: questionSource },
	});
	expect(context.plan.conversationPlan.threads[0]!.stances).toEqual([]);

	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.records.get(id)!.optionOrigins).toEqual({
		[OPTION_A]: { origin: "planner", source: questionSource },
		[OPTION_B]: { origin: "planner", source: questionSource },
	});
	expect(restored.conversationPlan.threads[0]!.stances).toEqual([]);
});

test("unrelated, foreign, mismatched, and unsupported sources cannot add options", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let question = "Should we use GitHub Apps or OAuth?";
	let { id, questionSource } = await conversationCard(context, "thread-a", question);
	let foreign = ref("message-thread-b", "Which database should we use?");
	context.plan.chat.entries.push({
		id: foreign.messageId,
		author: foreign.author,
		text: foreign.quote,
		ts: 2,
	});
	let foreignThread = applyEvent(initialState(), {
		id: "thread-b:opened",
		type: "thread.opened",
		threadId: "thread-b",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 3,
		source: foreign,
		question: foreign.quote,
	});
	context.plan.conversationPlan = {
		...context.plan.conversationPlan,
		revision: context.plan.conversationPlan.revision + foreignThread.revision,
		events: [...context.plan.conversationPlan.events, ...foreignThread.events],
		threads: [...context.plan.conversationPlan.threads, ...foreignThread.threads],
	};
	let substringStart = question.indexOf("GitHub Apps");
	let unrelated = {
		...questionSource,
		quote: "GitHub Apps",
		start: substringStart,
		end: substringStart + "GitHub Apps".length,
	};
	let mismatchStart = question.indexOf("OAuth?");
	let mismatchedQuote = {
		...questionSource,
		quote: "OAuth?",
		start: mismatchStart,
		end: mismatchStart + "OAuth?".length,
	};
	let invalid = [
		unrelated,
		foreign,
		mismatchedQuote,
		{ ...questionSource, role: "support" as const },
	];
	for (let [index, source] of invalid.entries()) {
		expect(
			await Questions.addServerOption(context.plan, context.server, "test", id, {
				optionId: index === 0 ? OPTION_A : OPTION_B.replace(/.$/, String(index)),
				label: `Alternative ${index}`,
				origin: "planner",
				source,
			}),
		).toEqual({ ok: false, reason: "invalid" });
	}
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toEqual([]);
	expect(context.plan.records.get(id)!.optionOrigins).toEqual({});
	expect(context.plan.conversationPlan.threads[0]!.stances).toEqual([]);
});

test("a question mention cannot source an unrelated option label", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let question = "Should we use GitHub Apps or OAuth?";
	let { id, questionSource } = await conversationCard(context, "thread-a", question);
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION_A,
			label: "Redis",
			origin: "planner",
			source: questionSource,
		}),
	).toEqual({ ok: false, reason: "invalid" });
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toEqual([]);
	expect(context.plan.records.get(id)!.optionOrigins).toEqual({});
});

test("the exact D02 hosting question sources both action-prefixed card options", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let question = "hosting for the beta: managed app service or our own server?";
	let { id, questionSource } = await conversationCard(context, "thread-hosting", question);

	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION_A,
			label: "Redis",
			origin: "planner",
			source: questionSource,
		}),
	).toEqual({ ok: false, reason: "invalid" });
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION_A,
			label: "Host our own server on a managed app service",
			origin: "planner",
			source: questionSource,
		}),
	).toEqual({ ok: false, reason: "invalid" });

	let managed = await Questions.addServerOption(context.plan, context.server, "test", id, {
		optionId: OPTION_A,
		label: "Host the beta on a managed app service",
		origin: "planner",
		source: questionSource,
	});
	let ownServer = await Questions.addServerOption(context.plan, context.server, "test", id, {
		optionId: OPTION_B,
		label: "Host the beta on our own server",
		origin: "planner",
		source: questionSource,
	});
	expect({ managed, ownServer }).toEqual({
		managed: { ok: true, optionId: OPTION_A },
		ownServer: { ok: true, optionId: OPTION_B },
	});

	expect(context.plan.records.get(id)!.optionOrigins).toEqual({
		[OPTION_A]: { origin: "planner", source: questionSource },
		[OPTION_B]: { origin: "planner", source: questionSource },
	});
	expect(context.plan.conversationPlan.threads[0]!.stances).toEqual([]);
});
