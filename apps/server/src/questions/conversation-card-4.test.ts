import { expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./service";
import * as Store from "./store";

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
let { OPTION, SECOND, input } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("server option growth retains the suggestion at its new card revision", async () => {
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
	expect(
		await Questions.addServerOption(context.plan, context.server, "test", id, {
			optionId: SECOND,
			label: "GitHub Apps",
			origin: "chat",
		}),
	).toEqual({ ok: true, optionId: SECOND });
	expect(Store.get(context.plan.questions, id)!.suggested).toEqual({
		optionId: OPTION,
		messageIds: ["m1"],
		revision: 2,
	});
	expect(context.broadcasts.at(-1)).toMatchObject({
		kind: "question:meta",
		meta: { suggested: { optionId: OPTION, revision: 2 } },
	});
});

test("a human-added option clears an advisory suggestion after commit", async () => {
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
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.addOption(context.plan, context.server, "test", ws, {
		kind: "question:add-option",
		ts: 0,
		rid: "add",
		id,
		label: "GitHub Apps",
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:add-option", ok: true });
	expect(Store.get(context.plan.questions, id)!.suggested).toBeUndefined();
	expect(context.broadcasts.at(-1)).toMatchObject({ kind: "question:meta" });
	expect(context.broadcasts.at(-1)).not.toHaveProperty("meta.suggested");
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(Store.get(restored.questions, id)!.suggested).toBeUndefined();
});

test("a saved suggestion can be explicitly accepted after a durable restart", async () => {
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
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(Store.get(restored.questions, id)!.suggested).toEqual({
		optionId: OPTION,
		messageIds: ["m1"],
		revision: 1,
	});
	expect(
		Question.read(
			Store.get(restored.questions, id)!.model,
			Store.get(restored.questions, id)!.definition,
		)[restored.records.get(id)!.definition.questions[0]!.id]!.choice,
	).toBeNull();
	let replies: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", client: "client-ana", room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	await Questions.submit(restored, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	expect(replies.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	expect(restored.records.get(id)).toMatchObject({
		status: "answered",
		choices: [OPTION],
		owner: "ana",
	});
	expect(room.project(restored.document)).toContain("Auth0");
});
