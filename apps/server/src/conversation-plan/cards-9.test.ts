import { expect, test } from "bun:test";

import { mirrorCard } from "./cards";

import { initialState } from "./domain";

import * as Questions from "../questions/service";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import { createProcessor } from "./service";
import { OPTION, plans, thread } from "./cards.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("live card listeners mirror a reopen emitted inside the room lock without deadlock", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	context.plan.conversationPlan = { ...initialState(), threads: [thread()] };
	let processor = createProcessor({
		plan: context.plan,
		exclusive: action => Service.exclusive(context.plan, action),
		persist: () => Service.persistExclusive(context.plan),
		publish: () => {},
		active: () => true,
	});
	let errors: unknown[] = [];
	let off = Questions.listen(context.plan, () => {
		void mirrorCard(context.plan, processor).catch(error => errors.push(error));
	});
	try {
		let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId: "thread-a",
			header: "Auth",
			question: "Which?",
			options: [{ id: OPTION, label: "GitHub Apps" }],
		});
		let actor = "ana";
		let ws = {
			data: {
				get handle() {
					return actor;
				},
				client: "client",
				room: "test",
			},
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
			rid: "save-1",
			id,
			revision: 1,
			suggestedOptionId: OPTION,
		});
		actor = "ben";
		await Questions.reopen(context.plan, context.server, "test", ws, {
			kind: "question:reopen",
			ts: 0,
			rid: "reopen",
			id,
		});
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
		for (let attempt = 0; attempt < 100 && context.plan.pendingCardActions.length; attempt++) {
			await Bun.sleep(1);
		}
		expect(errors).toEqual([]);
		expect(context.plan.pendingCardActions).toEqual([]);
		expect(context.plan.conversationPlan.events.map(event => event.id)).toEqual([
			`card:${id}:decided:1`,
			`card:${id}:reopened:1`,
			`card:${id}:decided:2`,
		]);
		expect(context.plan.conversationPlan.threads[0]!.decisionHistory.map(item => item.actor))
			.toEqual([
				{ kind: "member", handle: "ana" },
				{ kind: "member", handle: "cy" },
			]);
	} finally {
		off();
		processor.stop();
	}
});
