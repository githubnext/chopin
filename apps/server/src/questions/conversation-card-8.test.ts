import { expect, spyOn, test } from "bun:test";

import * as Questions from "./service";
import * as Store from "./store";

import { openPlan } from "../testing/plan";

import type { Socket } from "../wire";
import { createConversationCardFixture } from "./conversation-card.test-fixtures";
import type { Plan } from "../plan/service";

let plans: Plan[];
let fixture = createConversationCardFixture(() => plans, value => {
	plans = value;
});
plans = fixture.plans;
let { OPTION, SECOND, input, source } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a committed Save still wakes its durable prose outbox if its socket closes", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	await Questions.suggest(context.plan, context.server, "test", id, {
		optionId: OPTION,
		messageIds: ["m1"],
	});
	let wakes = 0;
	let unlisten = Questions.listen(context.plan, event => {
		if (event.kind === "decided") wakes++;
	});
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send() {
			throw new Error("socket closed");
		},
		publish() {},
	} as unknown as Socket;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		await Questions.submit(context.plan, context.server, "test", ws, {
			kind: "question:submit",
			ts: 0,
			rid: "save",
			id,
			revision: 1,
			suggestedOptionId: OPTION,
		});
	} finally {
		errors.mockRestore();
		unlisten();
	}
	expect(context.plan.records.get(id)?.status).toBe("answered");
	expect(context.plan.conversationPlanPendingEffects).toMatchObject([{
		key: `job:prose:${id}:1`,
	}]);
	expect(wakes).toBe(1);
});

test("only the winning concurrent Save captures a prose job claimant", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	let captured: string[] = [];
	let person = (handle: string) =>
		({
			data: { handle, client: `client-${handle}`, room: "test" },
			send() {},
			publish() {},
		}) as unknown as Socket;
	let ask = {
		kind: "question:submit" as const,
		ts: 0,
		rid: "save",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	};
	await Promise.all([
		Questions.submit(
			context.plan,
			context.server,
			"test",
			person("ana"),
			ask,
			intent => captured.push(`ana:${intent.trigger}`),
		),
		Questions.submit(
			context.plan,
			context.server,
			"test",
			person("ben"),
			ask,
			intent => captured.push(`ben:${intent.trigger}`),
		),
	]);
	expect(captured).toHaveLength(1);
	expect(captured[0]).toContain(`decided:${id}:1`);
	expect(captured[0]?.startsWith(context.plan.records.get(id)?.owner ?? "")).toBe(true);
});

test("closed cards and an active implementation refuse server-authored changes", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([
			{ id: OPTION, label: "GitHub Apps" },
		]),
	);
	context.plan.execution = { id: "run-1" } as never;
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: SECOND,
			label: "Auth0",
			origin: "chat",
		}),
	).toEqual({ ok: false, reason: "closed" });
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(false);
	await expect(Questions.insertConversationCard(context.plan, context.server, "test", {
		...input(),
		threadId: "thread-b",
	})).rejects.toThrow("implementation is active");
	context.plan.execution = undefined;
	context.plan.records.set(id, { ...context.plan.records.get(id)!, status: "discarded" });
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: SECOND,
			label: "Auth0",
			origin: "chat",
		}),
	).toEqual({ ok: false, reason: "closed" });
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(false);
});

test("involved puts the owner first, then card editors and thread participants", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(context.plan, context.server, "test", input());
	context.plan.conversationPlan.threads.push({
		id: "thread-a",
		question: "What auth system should we use?",
		questionSources: [source("opening")],
		questionAuthoring: "quoted",
		status: "exploring",
		contributions: [{
			id: OPTION,
			kind: "option",
			text: "GitHub Apps",
			authoring: "quoted",
			sources: [source("option")],
			actor: { kind: "classifier" },
		}],
		stances: [{
			id: "stance",
			participant: "participant",
			position: "support",
			sources: [source("stance")],
			at: 1,
		}],
		stanceHistory: [],
		decisionHistory: [],
		candidates: [],
		questionnaireId: id,
		version: 1,
	});
	let record = context.plan.records.get(id)!;
	context.plan.records.set(id, { ...record, owner: "owner", editors: ["editor"] });
	Store.get(context.plan.questions, id)!.editors.add("live");
	expect(Questions.involved(context.plan, context.plan.records.get(id)!)).toEqual([
		"owner",
		"editor",
		"live",
		"opening",
		"option",
		"stance",
		"participant",
	]);
});
