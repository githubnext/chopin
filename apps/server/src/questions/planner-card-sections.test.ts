import { afterEach, expect, test } from "bun:test";
import * as Question from "@chopin/question";

import { documentTools } from "../agent/tools";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import { meta } from "./card-notifications";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

import type { DocumentRoom } from "../agent/tools";
import type { Plan } from "../plan/service";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

const SOURCE = `# Login plan

## Goal

Verify the login handler.

## Strip rule

A short password has a strip no other password shares.

Known error, correction pending.

## Tests

Cover the boundary cases.
`;

async function opened(source = SOURCE, titled = false) {
	let context = await openPlan(source);
	if (titled) {
		await Service.close(context.plan);
		context.backend = { ...context.backend, documentTitles: true };
		context.plan = await Service.open(context.channel.id, context.backend, context.server);
	}
	plans.push(context.plan);
	let room: DocumentRoom = {
		id: context.plan.id,
		plan: context.plan,
		server: context.server,
		persist: () => Service.persist(context.plan),
		exclusive: action => Service.exclusive(context.plan, action),
		publish: async () => {},
		anchors: () => {},
		changes: () => {},
	};
	return { ...context, room };
}

function blockText(plan: Plan, index: number): string {
	return Room.project(plan.document).split("\n\n")[index]!.trim();
}

/** The blocks a card's single question is linked to, by their text, if it is linked. */
function linkedTo(plan: Plan, id: string): string[] | "pending" | "orphaned" {
	let set = Object.values(Questions.anchors(plan).find(item => item.widget === id)!.questions)[0]!;
	if (set.anchors.some(anchor => anchor.orphaned)) return "orphaned";
	if (set.pending) return "pending";
	let digests = Room.digests(plan.document);
	return set.anchors.map(anchor => blockText(plan, digests.indexOf(anchor.digest)));
}

function rewrite(plan: Plan, from: string, to: string) {
	let source = Service.source(plan);
	let next = source.replace(from, to);
	expect(next).not.toBe(source);
	return Service.rewrite(plan, next, undefined);
}

async function save(plan: Plan, server: Parameters<typeof Questions.submit>[1], id: string) {
	let actor = member();
	let entry = Store.get(plan.questions, id)!;
	let question = entry.definition.questions[0]!;
	let fork = entry.model.fork() as Question.Model;
	if (question.options.length) fork.api.val([question.id, "choice"]).set(question.options[0]!.id);
	else fork.api.str([question.id, "custom"]).ins(0, "Keep it running.");
	await Questions.edit(plan, actor.ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
		id,
		patch: [...fork.api.flush().toBinary()],
	});
	await Questions.submit(plan, server, plan.id, actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(plan.questions, id)!.revision,
	});
	expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
}

async function openDecision(
	context: Awaited<ReturnType<typeof opened>>,
	extra: Record<string, unknown> = {},
) {
	let result = await documentTools.open_decision.execute!(
		{
			revision: context.plan.revision,
			key: "replacement-run",
			question: "Should the replacement run keep going?",
			...extra,
		},
		{ toolCallId: "open", messages: [], context: { room: context.room } } as never,
	);
	return JSON.parse(result as string).id as string;
}

test("a decision the Planner opens without naming a block sits beside the first section and is linked to it", async () => {
	let context = await opened();
	let id = await openDecision(context);

	expect(linkedTo(context.plan, id)).toEqual(["## Goal"]);
	// The card follows the section heading rather than trailing the document.
	expect(blockText(context.plan, 2)).toContain(`<Questionnaire id="${id}"`);

	await save(context.plan, context.server, id);
	expect(linkedTo(context.plan, id)).toEqual(["## Goal"]);
});

test("a decision the Planner opens beside a named block is linked to that block", async () => {
	let context = await opened();
	let digests = Room.digests(context.plan.document);
	let id = await openDecision(context, { blocks: [{ index: 5, digest: digests[5]! }] });

	expect(linkedTo(context.plan, id)).toEqual(["Known error, correction pending."]);
	expect(blockText(context.plan, 6)).toContain(`<Questionnaire id="${id}"`);
});

test("a decision the Planner opens in a document with only a title has no section to sit beside", async () => {
	let context = await opened("# Login plan\n", true);
	let id = await openDecision(context);

	expect(context.plan.records.get(id)!.anchors).toBeUndefined();
	expect(blockText(context.plan, 1)).toContain(`<Questionnaire id="${id}"`);
});

test("a whole-document rewrite of a Planner card's block keeps the card linked to its section", async () => {
	let context = await opened();
	let digests = Room.digests(context.plan.document);
	let id = await openDecision(context, { blocks: [{ index: 4, digest: digests[4]! }] });
	await save(context.plan, context.server, id);

	expect(
		(await rewrite(
			context.plan,
			"A short password has a strip no other password shares.",
			"Two short passwords without a NUL byte never share a strip.",
		)).ok,
	).toBe(true);

	// A rewritten paragraph is a new block, so the card keeps the section it was in.
	expect(linkedTo(context.plan, id)).toEqual(["## Strip rule"]);
	expect(Questions.outstanding(context.plan)).toEqual([]);
});

test("a whole-document rewrite that deletes a Planner card's block links it to the nearest surviving heading, without a failed write-up", async () => {
	let context = await opened();
	let digests = Room.digests(context.plan.document);
	let result = await Questions.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [{
			key: "keep-replacement-run",
			header: "Run",
			question: "Should the replacement run keep going?",
			options: [
				{ label: "Keep it running (recommended)", description: "" },
				{ label: "Stop it", description: "" },
			],
			multiple: false,
			blocks: [{ index: 5, digest: digests[5]! }],
		}],
	});
	let id = result.decisions[0]!.id;
	expect(context.plan.records.get(id)!.followUp).toBeDefined();

	expect((await rewrite(context.plan, "Known error, correction pending.\n\n", "")).ok).toBe(true);
	expect(linkedTo(context.plan, id)).toEqual(["## Strip rule"]);

	await save(context.plan, context.server, id);
	let record = context.plan.records.get(id)!;
	expect(meta(context.plan, record).writeup).toBeUndefined();
	expect(linkedTo(context.plan, id)).toEqual(["## Strip rule"]);
	expect(Questions.outstanding(context.plan)).toEqual([]);

	// What the room committed is what a reopened document reads.
	await Service.close(plans.pop()!);
	let reopened = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(reopened);
	expect(linkedTo(reopened, id)).toEqual(["## Strip rule"]);
});

test("when the card's own section heading goes too, it falls back to the heading above", async () => {
	let context = await opened();
	let digests = Room.digests(context.plan.document);
	let id = await openDecision(context, { blocks: [{ index: 5, digest: digests[5]! }] });

	expect(
		(await rewrite(
			context.plan,
			"## Strip rule\n\nA short password has a strip no other password shares.\n\n"
				+ "Known error, correction pending.\n\n",
			"",
		)).ok,
	).toBe(true);

	expect(linkedTo(context.plan, id)).toEqual(["## Goal"]);
});
