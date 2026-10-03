import { expect, test } from "bun:test";

import * as Questions from "./service";

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
let { OPTION, input } = fixture;

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("rapid Save, Reopen, Save retains each actor and generation without a mirror listener", async () => {
	let context = await openPlan("Only paragraph.\n");
	plans.push(context.plan);
	let id = await Questions.insertConversationCard(
		context.plan,
		context.server,
		"test",
		input([{ id: OPTION, label: "Auth0" }]),
	);
	let replies: Array<Record<string, unknown>> = [];
	let actor = "ana";
	let ws = {
		data: {
			get handle() {
				return actor;
			},
			client: "client",
			room: "test",
		},
		send(raw: string) {
			replies.push(JSON.parse(raw));
		},
		publish() {},
	} as unknown as Socket;
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m1"],
		}),
	).toBe(true);
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save-1",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	let first = context.plan.records.get(id)!;
	context.plan.records.set(id, {
		...first,
		prose: [{
			...room.anchorAt(context.plan.document, 0, room.digests(context.plan.document)[0]!),
			orphaned: true,
		}],
	});
	await Service.persist(context.plan);
	actor = "ben";
	await Questions.reopen(context.plan, context.server, "test", ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});
	expect(room.questionnaireIndex(context.plan.document, id)).toBe(1);
	expect(context.plan.records.get(id)?.prose?.[0]?.orphaned).toBe(true);
	expect(
		await Questions.suggest(context.plan, context.server, "test", id, {
			optionId: OPTION,
			messageIds: ["m2"],
		}),
	).toBe(true);
	actor = "cy";
	await Questions.submit(context.plan, context.server, "test", ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save-2",
		id,
		revision: 1,
		suggestedOptionId: OPTION,
	});
	expect(replies.filter(frame => frame.ok).map(frame => frame.kind)).toEqual([
		"question:submit",
		"question:reopen",
		"question:submit",
	]);
	expect(context.plan.pendingCardActions.map(action => [action.id, action.actor])).toEqual([
		[`card:${id}:decided:1`, "ana"],
		[`card:${id}:reopened:1`, "ben"],
		[`card:${id}:decided:2`, "cy"],
	]);
	expect(context.plan.conversationPlanPendingEffects.filter(item => item.kind === "job"))
		.toMatchObject([
			{ key: `job:prose:${id}:1`, intent: { kind: "prose", trigger: `decided:${id}:1` } },
			{ key: `job:prose:${id}:2`, intent: { kind: "prose", trigger: `decided:${id}:2` } },
		]);
	expect(context.plan.pendingCardActions[0]).toMatchObject({
		threadId: "thread-a",
		optionIds: [OPTION],
		text: "Auth0",
	});
	await Service.close(context.plan);
	plans = [];
	let restored = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.pendingCardActions).toEqual(context.plan.pendingCardActions);
	expect(restored.conversationPlanPendingEffects).toEqual(
		context.plan.conversationPlanPendingEffects,
	);
});
