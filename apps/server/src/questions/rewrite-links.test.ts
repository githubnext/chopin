import { afterEach, expect, test } from "bun:test";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import * as Questions from "./service";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SOURCE = `Storage section.

Deployment section.

Retention section.

<Questionnaire id="${WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${QUESTION}" header="Cache" prompt="How long do we cache?" multiple="false">
<Option id="${OPTION}" label="60 seconds" />
<Answer value="60 seconds" />
</Question>
</Questionnaire>
`;

let plans: Service.Plan[] = [];
let reopen = new Map<Service.Plan, () => Promise<Service.Plan>>();

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
	reopen.clear();
});

/** An answered decision the Planner linked to the given blocks, reviewed. */
async function linked(indices: number[]) {
	let context = await openPlan(SOURCE, {
		revision: 1,
		questions: [{
			id: WIDGET,
			status: "answered",
			resolver: "ana",
			definition: {
				questions: [{
					id: QUESTION,
					header: "Cache",
					question: "How long do we cache?",
					multiple: false,
					options: [{ id: OPTION, label: "60 seconds", description: "" }],
				}],
			},
			answers: { [QUESTION]: "60 seconds" },
		}],
	});
	plans.push(context.plan);
	reopen.set(context.plan, () => Service.open(context.channel.id, context.backend, context.server));
	let digests = room.digests(context.plan.document);
	let blocks = indices.map(index => ({ index, digest: digests[index]! }));
	expect(Questions.relate(context.plan, WIDGET, QUESTION, blocks)).toBeUndefined();
	await Service.persist(context.plan);
	expect(Questions.outstanding(context.plan)).toEqual([]);
	return context.plan;
}

function rewrite(plan: Service.Plan, from: string, to: string) {
	let source = Service.source(plan);
	let next = source.replace(from, to);
	expect(next).not.toBe(source);
	return Service.rewrite(plan, next, undefined);
}

function link(plan: Service.Plan) {
	return Questions.anchors(plan).find(item => item.widget === WIDGET)!.questions[QUESTION]!;
}

test("a rewrite that leaves a decision's blocks alone keeps its link reviewed", async () => {
	let plan = await linked([0]);

	expect((await rewrite(plan, "Deployment section.", "Deployment section, revised.")).ok)
		.toBe(true);

	let set = link(plan);
	expect(set.pending).toBe(false);
	expect(set.reason).toBeUndefined();
	expect(set.anchors).toHaveLength(1);
	expect(set.anchors[0]!.orphaned).toBeUndefined();
	expect(room.digests(plan.document).indexOf(set.anchors[0]!.digest)).toBe(0);
	expect(Questions.outstanding(plan)).toEqual([]);

	await Service.close(plans.pop()!);
	let reopened = await reopen.get(plan)!();
	plans.push(reopened);
	expect(link(reopened).pending).toBe(false);
	expect(Questions.outstanding(reopened)).toEqual([]);
});

test("a rewrite of the linked block owes a review", async () => {
	let plan = await linked([0]);

	expect((await rewrite(plan, "Storage section.", "Storage section, revised.")).ok).toBe(true);

	expect(link(plan).pending).toBe(true);
	expect(Questions.outstanding(plan)).toHaveLength(1);
});

test("a rewrite flags a decision when any one of its blocks changed or went away", async () => {
	let edited = await linked([0, 1]);
	expect((await rewrite(edited, "Deployment section.", "Deployment section, revised.")).ok)
		.toBe(true);
	expect(link(edited).pending).toBe(true);

	let removed = await linked([0, 2]);
	expect((await rewrite(removed, "Retention section.\n\n", "")).ok).toBe(true);
	expect(link(removed).pending).toBe(true);
	expect(link(removed).anchors.map(anchor => !!anchor.orphaned)).toEqual([false, true]);
});

test("a rewrite leaves pending and deliberately unlinked decisions owing a review", async () => {
	let pending = await linked([0]);
	Questions.invalidate(pending, "plan_changed");
	expect((await rewrite(pending, "Deployment section.", "Deployment section, revised.")).ok)
		.toBe(true);
	expect(link(pending)).toMatchObject({ pending: true, reason: "plan_changed" });

	let unlinked = await linked([]);
	expect((await rewrite(unlinked, "Deployment section.", "Deployment section, revised.")).ok)
		.toBe(true);
	expect(link(unlinked)).toMatchObject({ anchors: [], pending: true, reason: "plan_changed" });
});
