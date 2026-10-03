import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./service";
import * as Store from "./store";

import * as Jobs from "../conversation-plan/jobs";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { Socket } from "../wire";
import { createConversationCardFixture } from "./conversation-card.test-fixtures";
import type { Plan } from "../plan/service";

let plans: Plan[];
let fixture = createConversationCardFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION, input, quotedOption } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a pending conversation card without options appends once and survives restart", async () => {
	let context = await openPlan("Opening paragraph.\n");
	plans.push(context.plan);
	let [id, repeated] = await Promise.all([
		Questions.insertConversationCard(context.plan, context.server, "test", input()),
		Questions.insertConversationCard(context.plan, context.server, "test", input()),
	]);
	expect(repeated).toBe(id);
	expect(context.plan.records.size).toBe(1);
	expect(context.plan.records.get(id)).toMatchObject({
		origin: "conversation",
		threadId: "thread-a",
		status: "open",
		editors: [],
	});
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toEqual([]);
	expect(Store.get(context.plan.questions, id)!.settle).toBeUndefined();
	let source = room.project(context.plan.document);
	expect(source.indexOf("Opening paragraph.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(source).toContain('thread="thread-a"');
	expect(source).toContain("<Question id=");
	expect(source).not.toContain("<Option id=");
	expect(context.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(1);

	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.records.get(id)?.definition.questions[0]?.options).toEqual([]);
	expect(Store.get(restored.questions, id)?.settle).toBeUndefined();
	expect(room.project(restored.document)).toBe(source);
});

test("card metadata reports only pending or running refine jobs for that card", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	let record = context.plan.records.get(id)!;
	expect(Questions.meta(context.plan, record).refining).toBe(false);
	context.plan.conversationPlanJobs = Jobs.enqueue([], {
		kind: "refine",
		target: id,
		trigger: "m1",
	}, "2026-09-25T10:00:00.000Z");
	expect(Questions.meta(context.plan, record).refining).toBe(true);
	context.plan.conversationPlanJobs = Jobs.start(
		context.plan.conversationPlanJobs,
		`refine:${id}:m1`,
		"2026-09-25T10:00:01.000Z",
	);
	expect(Questions.meta(context.plan, record).refining).toBe(true);
	context.plan.conversationPlanJobs = Jobs.settle(
		context.plan.conversationPlanJobs,
		`refine:${id}:m1`,
		{ status: "done", output: "{}" },
		"2026-09-25T10:00:02.000Z",
	);
	expect(Questions.meta(context.plan, record).refining).toBe(false);
});

test("a conversation card can be discarded before anyone adds an option", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.discard(context.plan, context.server, "test", ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id,
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:discard", ok: true });
	expect(context.plan.records.get(id)?.status).toBe("discarded");
	expect(room.project(context.plan.document)).toContain('status="discarded"');
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.records.get(id)?.status).toBe("discarded");
	expect(restored.records.get(id)?.definition.questions[0]?.options).toEqual([]);
	expect(room.project(restored.document)).toContain('status="discarded"');
});

test("the first quoted option keeps its ID, persists provenance, and makes the card suggestible", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	let before = context.broadcasts.length;
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION,
			label: "GitHub Apps",
			origin: "chat",
		}),
	).toEqual({ ok: true, optionId: OPTION });
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: OPTION,
			label: "GitHub Apps",
			origin: "chat",
		}),
	).toEqual({ ok: true, optionId: OPTION });
	expect(context.plan.records.get(id)!.definition.questions[0]!.options).toEqual([{
		id: OPTION,
		label: "GitHub Apps",
		description: "",
	}]);
	expect(context.plan.records.get(id)!.optionOrigins[OPTION]).toEqual({ origin: "chat" });
	expect(context.broadcasts.slice(before).filter(frame => frame.kind === "question:changed"))
		.toHaveLength(1);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	expect(
		Question.read(
			Store.get(context.plan.questions, id)!.model,
			Store.get(context.plan.questions, id)!.definition,
		)[context.plan.records.get(id)!.definition.questions[0]!.id]!.choice,
	).toBeNull();
	expect(Store.get(context.plan.questions, id)!.suggested).toEqual({
		optionId: OPTION,
		messageIds: ["m1"],
		revision: 2,
	});
});

test("a quoted option relabel commits card and event together, and survives restart", async () => {
	let { context, id, state } = await quotedOption();
	let revision = Store.get(context.plan.questions, id)!.revision;
	let request = {
		operationId: "shorten-github",
		threadId: "thread-a",
		optionId: OPTION,
		label: "GitHub Apps",
		expectedThreadVersion: state.threads[0]!.version,
		expectedCardRevision: revision,
	};
	let result = await Questions.relabelConversationOption(
		context.plan,
		context.server,
		"test",
		request,
	);
	expect(result.eventId).toBe("option-relabel:shorten-github");
	expect(context.plan.conversationPlan.threads[0]!.contributions[0]).toMatchObject({
		id: OPTION,
		text: "We should use GitHub Apps for auth",
		displayLabel: "GitHub Apps",
		sources: [{ quote: "We should use GitHub Apps for auth", start: 0, end: 34 }],
	});
	expect(context.plan.records.get(id)!.definition.questions[0]!.options[0]).toMatchObject({
		id: OPTION,
		label: "GitHub Apps",
	});
	expect(context.plan.records.get(id)!.optionOrigins[OPTION]).toEqual({ origin: "chat" });
	expect(room.project(context.plan.document)).toContain('label="GitHub Apps"');
	let broadcastCount = context.broadcasts.length;
	expect(await Questions.relabelConversationOption(context.plan, context.server, "test", request))
		.toEqual({ eventId: result.eventId, revision: result.revision });
	expect(context.broadcasts).toHaveLength(broadcastCount);
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.conversationPlan.threads[0]!.contributions[0]!.displayLabel).toBe("GitHub Apps");
	expect(restored.records.get(id)!.definition.questions[0]!.options[0]!.label).toBe("GitHub Apps");
});
