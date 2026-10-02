import { expect, test } from "bun:test";
import * as Y from "yjs";
import * as edit from "../plan/edit";
import * as room from "../plan/room";
import * as Prose from "./prose";
import type { Plan } from "../plan/service";

function assertAt(
	document: room.Document,
	anchor: ReturnType<typeof room.anchorAt>,
	index: number,
) {
	expect(anchor.orphaned).toBeUndefined();
	expect(room.matchesAnchor(document, anchor, index)).toBe(true);
	expect(anchor.digest).toBe(room.digests(document)[index]);
}

test("two decision passages survive replacement and an unrelated Planner append", async () => {
	let document = await room.create("# Title\n\nSentry monitoring.\n\nSlack alerts.\n");
	let plan = { document, revision: 1, outlines: new Map() } as Plan;
	try {
		let monitor = room.anchorAt(document, 1, room.digests(document)[1]!);
		let alert = room.anchorAt(document, 2, room.digests(document)[2]!);
		assertAt(document, monitor, 1);
		assertAt(document, alert, 2);

		let beforeReplacement = room.project(document);
		let replaced = edit.apply(plan, 1, [{
			op: "replace",
			index: 1,
			source: "Grafana monitoring.\n",
		}]);
		expect(replaced.ok).toBe(true);
		[alert] = Prose.carry(document, [alert], beforeReplacement);
		monitor = room.anchorAt(document, 1, room.digests(document)[1]!);
		assertAt(document, monitor, 1);
		assertAt(document, alert, 2);

		let beforeAppend = room.project(document);
		let appended = edit.apply(plan, 1, [{
			op: "insert",
			index: 2,
			source: "- Browser one\n- Browser two\n- Browser three\n",
		}]);
		expect(appended.ok).toBe(true);
		[monitor] = Prose.carry(document, [monitor], beforeAppend);
		[alert] = Prose.carry(document, [alert], beforeAppend);
		assertAt(document, monitor, 1);
		assertAt(document, alert, 2);

		let restored = await room.restore(
			document.epoch,
			Y.encodeStateAsUpdate(document.doc),
			room.project(document),
			[],
		);
		try {
			[monitor] = Prose.carry(restored, [monitor], room.project(document));
			[alert] = Prose.carry(restored, [alert], room.project(document));
			assertAt(restored, monitor, 1);
			assertAt(restored, alert, 2);
		} finally {
			restored.doc.destroy();
		}
	} finally {
		document.doc.destroy();
	}
});

import * as Service from "../plan/service";
import * as Questions from "./service";
import { createDecisionProseFixture } from "../agent/decision-prose.test-fixtures";

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
