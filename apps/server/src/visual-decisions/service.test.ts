import { afterEach, expect, test } from "bun:test";
import type { VisualDecision } from "@chopin/protocol";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import { CommitRejected } from "../storage/errors";
import type { Socket } from "../wire";
import * as Decisions from "./service";
import * as State from "./state";
import { revisionDigest } from "./revision";

let base: Omit<VisualDecision.Definition, "definitionRevision"> = {
	schema: "visual-decision@1",
	title: "Billing card",
	requestId: "billing-request",
	artifact: { ref: "fixture-billing-card", digest: `sha256:${"a".repeat(64)}` },
	controls: [
		{
			type: "number",
			id: "cardSpacing",
			label: "Card spacing",
			unit: "px",
			min: 8,
			max: 24,
			step: 4,
		},
		{ type: "color", id: "accentColor", label: "Accent colour" },
	],
	baseline: { cardSpacing: 16, accentColor: "#AABBCC" },
};
let definition: VisualDecision.Definition = {
	...base,
	definitionRevision: revisionDigest(base),
};

let plans: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

function member(plan: Service.Plan, canEdit = true) {
	let frames: Record<string, unknown>[] = [];
	let ws = {
		data: { room: plan.id, handle: "ana", canEdit, closed: false, client: crypto.randomUUID() },
		send(raw: string) {
			frames.push(JSON.parse(raw));
		},
	} as unknown as Socket;
	let client = crypto.randomUUID();
	let sequence = 0;
	return { ws, frames, key: () => `${client}:${++sequence}` };
}

async function fixture() {
	let context = await openPlan("Nearby prose.");
	plans.push(context.plan);
	let state = await Decisions.create(context.plan, definition, async () => true);
	let actor = member(context.plan);
	return { ...context, state, actor };
}

test("only a verified artifact creates a durable generic card", async () => {
	let context = await openPlan();
	plans.push(context.plan);
	await expect(Decisions.create(context.plan, definition, async () => false)).rejects.toThrow();
	expect(context.plan.visualDecisions.size).toBe(0);
	let first = await Decisions.create(context.plan, definition, async () => true);
	await expect(Decisions.create(context.plan, {
		...definition,
		title: "Different title",
	}, async () => true)).rejects.toThrow(/revision/);
	let replay = await Decisions.create(context.plan, definition, async () => false);
	expect(replay).toEqual(first);
	expect(context.plan.visualDecisions.size).toBe(1);
	let restored = State.restore(State.dump(context.plan.visualDecisions));
	expect(restored.get(first.id)?.definition).toEqual(definition);
	let stored = State.dump(context.plan.visualDecisions)[0]!;
	expect(() =>
		State.restore([{
			...stored,
			definition: { ...stored.definition, title: "Tampered title" },
		}])
	).toThrow(/revision/);
});

test("Save binds current draft and definition, then survives restart", async () => {
	let context = await fixture();
	await Decisions.edit(context.plan, context.actor.ws, {
		kind: "visual-decision:edit",
		ts: 0,
		rid: "edit",
		id: context.state.id,
		key: context.actor.key(),
		patch: { cardSpacing: 20 },
	});
	expect(context.actor.frames.at(-1)).toMatchObject({ ok: true, state: { revision: 1 } });
	await Decisions.save(context.plan, context.actor.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "stale",
		id: context.state.id,
		revision: 1,
		definitionRevision: `sha256:${"c".repeat(64)}`,
	});
	expect(context.actor.frames.at(-1)).toMatchObject({ ok: false, reason: "stale" });
	await Decisions.save(context.plan, context.actor.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "save",
		id: context.state.id,
		revision: 1,
		definitionRevision: definition.definitionRevision,
	});
	expect(context.actor.frames.at(-1)).toMatchObject({
		ok: true,
		state: {
			saved: {
				decisionId: context.state.id,
				requestId: definition.requestId,
				artifactDigest: definition.artifact.digest,
				values: { cardSpacing: 20 },
			},
		},
	});
	await Service.close(context.plan);
	plans.splice(plans.indexOf(context.plan), 1);
	let restored = await Service.open(context.plan.id, context.backend, context.server);
	plans.push(restored);
	expect(restored.visualDecisions.get(context.state.id)?.saved?.values).toEqual({
		cardSpacing: 20,
		accentColor: "#AABBCC",
	});
});

test("a fully rejected Save keeps the accepted draft available for retry", async () => {
	let context = await fixture();
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new CommitRejected();
	};
	try {
		await Decisions.save(context.plan, context.actor.ws, {
			kind: "visual-decision:save",
			ts: 0,
			rid: "reject",
			id: context.state.id,
			revision: 0,
			definitionRevision: definition.definitionRevision,
		});
	} finally {
		context.storage.collaboration.commit = original;
	}
	expect(context.actor.frames.at(-1)).toMatchObject({ kind: "session:error" });
	expect(context.plan.visualDecisions.get(context.state.id)?.saved).toBeUndefined();
	await Decisions.save(context.plan, context.actor.ws, {
		kind: "visual-decision:save",
		ts: 0,
		rid: "retry",
		id: context.state.id,
		revision: 0,
		definitionRevision: definition.definitionRevision,
	});
	expect(context.actor.frames.at(-1)).toMatchObject({ ok: true });
});
