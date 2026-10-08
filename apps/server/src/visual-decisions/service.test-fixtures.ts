import { afterEach } from "bun:test";
import type { VisualDecision } from "@chopin/protocol";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import type { Socket } from "../wire";
import * as Decisions from "./service";

export let definition: VisualDecision.Definition = {
	specimen: "decision-card-v1",
	bundleDigest: `sha256:${"a".repeat(64)}`,
	baseline: { optionPadding: 6, selectedColor: "#E1ECEF" },
	controls: [
		{ id: "optionPadding", type: "number", min: 4, max: 8, step: 2 },
		{ id: "selectedColor", type: "color", format: "#RRGGBB" },
	],
};

let plans: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

export function member(plan: Service.Plan, handle = "ana", canEdit = true) {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { room: plan.id, handle, canEdit, client: crypto.randomUUID() },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	let client = crypto.randomUUID();
	let sequence = 0;
	return { ws, frames, key: () => `${client}:${++sequence}` };
}

export async function fixture() {
	let context = await openPlan("Neighbor prose.");
	plans.push(context.plan);
	let ana = member(context.plan);
	let createKey = crypto.randomUUID();
	await Decisions.create(context.plan, ana.ws, {
		kind: "visual-decision:create",
		ts: 0,
		rid: "create",
		key: createKey,
	}, definition);
	if (ana.frames.at(-1)?.ok !== true) throw new Error(JSON.stringify(ana.frames.at(-1)));
	let id = [...context.plan.visualDecisions.keys()][0]!;
	return { ...context, ana, id, createKey };
}

export async function edit(
	context: Awaited<ReturnType<typeof fixture>>,
	actor: ReturnType<typeof member>,
	patch: Partial<VisualDecision.Values>,
	key = actor.key(),
) {
	await Decisions.edit(context.plan, actor.ws, {
		kind: "visual-decision:edit",
		ts: 0,
		rid: `edit:${key}`,
		id: context.id,
		key,
		patch,
	});
	return actor.frames.at(-1);
}

export async function restart(context: Awaited<ReturnType<typeof fixture>>) {
	await Service.close(context.plan);
	plans.splice(plans.indexOf(context.plan), 1);
	let plan = await Service.open(context.plan.id, context.backend, context.server);
	plans.push(plan);
	return plan;
}
