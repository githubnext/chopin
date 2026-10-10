import { afterEach, expect, test } from "bun:test";

import { documentTools } from "../agent/tools";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { announceImplementation } from "./notifications";
import { pendingLinks, relinkInstruction } from "./relink";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SOURCE = `The renderer caches tiles for 60 seconds.

<Questionnaire id="${WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${QUESTION}" header="Cache" prompt="How long do we cache?" multiple="false">
<Option id="${OPTION}" label="60 seconds" />
<Answer value="60 seconds" />
</Question>
</Questionnaire>
`;

let plans: Service.Plan[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function answered(liveBuild: boolean) {
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
	context.plan.persistence.liveBuild = liveBuild;
	// What `edit_plan` leaves behind: every answered decision owes a review.
	Questions.invalidate(context.plan, "plan_changed");
	return context;
}

function build(kind?: "rebuild", state = "running") {
	return { id: crypto.randomUUID(), state, ...(kind ? { kind } : {}) } as never;
}

async function anchor(plan: Service.Plan, server: unknown) {
	let item = documentTools.anchor_plan;
	let args = {
		revision: plan.revision,
		anchors: [{
			widget: WIDGET,
			question: QUESTION,
			blocks: [{ index: 0, digest: room.digests(plan.document)[0]! }],
		}],
	};
	let context = {
		room: {
			id: "test",
			plan,
			server,
			persist: () => Service.persist(plan),
			exclusive: (action: () => Promise<unknown>) => Service.exclusive(plan, action),
			publish: (mutation: room.Mutation) =>
				Service.publish(plan, server as never, "test", mutation),
			anchors() {},
			changes() {},
		},
		repository: { id: "R_test" },
	};
	let response = await item.execute!(
		args as never,
		{ context, toolCallId: "call", messages: [] } as never,
	);
	return JSON.parse(response as string);
}

test("anchor_plan links decisions during a living-document rebuild but not a first build", async () => {
	let { plan, server } = await answered(true);
	expect(Questions.outstanding(plan)).toHaveLength(1);

	plan.builds = [build()];
	expect(await anchor(plan, server)).toMatchObject({ ok: false, reason: "locked" });
	expect(Questions.outstanding(plan)).toHaveLength(1);

	plan.builds = [build(undefined, "stopped"), build("rebuild")];
	expect(await anchor(plan, server)).toMatchObject({ ok: true, anchors_pending: [] });
	expect(Questions.outstanding(plan)).toEqual([]);
});

test("links a first build refused are owed only once its lock releases", async () => {
	let { plan } = await answered(true);
	plan.builds = [build()];
	expect(pendingLinks(plan)).toEqual([]);

	plan.builds = [build(undefined, "stopped")];
	expect(pendingLinks(plan)).toEqual([
		{ widget: WIDGET, question: QUESTION, reason: "plan_changed" },
	]);
	let instruction = relinkInstruction(pendingLinks(plan));
	expect(instruction).toContain(`widget ${WIDGET}, question ${QUESTION}`);
	expect(instruction).toContain("anchor_plan");
});

test("a released first build asks for re-linking once, and never with the flag off", async () => {
	let { plan } = await answered(true);
	let unlocked: string[] = [];
	plan.persistence.onEditingUnlocked = id => unlocked.push(id);

	// A rebuild never takes the lock, so finishing one owes nothing.
	plan.builds = [build("rebuild")];
	announceImplementation(plan);
	plan.builds = [build("rebuild", "stopped")];
	announceImplementation(plan);
	expect(unlocked).toEqual([]);

	plan.builds = [build()];
	announceImplementation(plan);
	plan.builds = [build(undefined, "stopped")];
	announceImplementation(plan);
	announceImplementation(plan);
	expect(unlocked).toEqual([plan.id]);

	let off = (await answered(false)).plan;
	off.persistence.onEditingUnlocked = id => unlocked.push(id);
	off.builds = [build()];
	announceImplementation(off);
	off.builds = [build(undefined, "stopped")];
	announceImplementation(off);
	expect(unlocked).toEqual([plan.id]);
	expect(pendingLinks(off)).toEqual([]);
});
