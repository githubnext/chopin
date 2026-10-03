import { expect, test } from "bun:test";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "./service";
import { createDecisionProseFixture } from "../agent/decision-prose.test-fixtures";

function assertAt(
	document: room.Document,
	anchor: ReturnType<typeof room.anchorAt>,
	index: number,
) {
	expect(anchor.orphaned).toBeUndefined();
	expect(room.matchesAnchor(document, anchor, index)).toBe(true);
	expect(anchor.digest).toBe(room.digests(document)[index]);
}

let contexts: ReturnType<typeof createDecisionProseFixture>["contexts"];
let fixture = createDecisionProseFixture(() => contexts, value => contexts = value);
contexts = fixture.contexts;

test("two staged decision prose jobs keep separate anchors through replacement and Planner append", async () => {
	let { CARD, OTHER_WIDGET, WIDGET, opened, job, proseTool, input } = fixture;
	let second = "01K0N4X2M5R8T3VQ7YB6ZC4DEF";
	let context = await opened(`Context.\n\n${WIDGET}\n${OTHER_WIDGET}`);
	let original = context.plan.records.get(CARD)!;
	context.plan.records.set(
		second,
		Questions.normalizeRecord({
			...original,
			id: second,
			threadId: "t2",
			definition: {
				questions: original.definition.questions.map(question => ({
					...question,
					id: "01K0N4Y2M5R8T3VQ7YB6ZC4DEF",
					options: question.options.map(option => ({
						...option,
						id: "01K0N4Z2M5R8T3VQ7YB6ZC4DEF",
					})),
				})),
			},
			choices: ["01K0N4Z2M5R8T3VQ7YB6ZC4DEF"],
		}),
	);
	let tool = proseTool(context);
	let check = (first: number, secondIndex?: number) => {
		assertAt(context.plan.document, context.plan.records.get(CARD)!.prose![0]!, first);
		if (secondIndex !== undefined) {
			assertAt(context.plan.document, context.plan.records.get(second)!.prose![0]!, secondIndex);
		}
	};
	job(context);
	expect(
		JSON.parse(String(await tool.handler(input(context, "Sentry monitoring."), {} as never))).ok,
	).toBe(true);
	check(1);
	context.plan.chat.job = {
		id: `prose:${second}:decided:${second}:1`,
		kind: "prose",
		target: second,
		trigger: `decided:${second}:1`,
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
	expect(
		JSON.parse(
			String(
				await tool.handler(
					{ revision: context.plan.revision, id: second, text: "Slack alerts." },
					{} as never,
				),
			),
		).ok,
	).toBe(true);
	check(1, 3);
	job(context);
	expect(
		JSON.parse(String(await tool.handler(input(context, "Grafana monitoring."), {} as never))).ok,
	).toBe(true);
	check(1, 3);
	let before = room.project(context.plan.document);
	let outcome = edit.apply(context.plan, context.plan.revision, [{
		op: "insert",
		index: room.digests(context.plan.document).length - 1,
		source: "- Browser one\n- Browser two\n- Browser three\n",
	}]);
	expect(outcome.ok).toBe(true);
	Questions.rebase(context.plan, before);
	check(1, 3);
	await Service.persist(context.plan);
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	try {
		assertAt(reopened.document, reopened.records.get(CARD)!.prose![0]!, 1);
		assertAt(reopened.document, reopened.records.get(second)!.prose![0]!, 3);
	} finally {
		await Service.close(reopened);
	}
});
