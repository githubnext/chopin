import { afterEach, expect, test } from "bun:test";
import * as Question from "@chopin/question";

import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import { answerInstruction, answerTurns } from "./answer-turns";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

import type { Instruction } from "../chat/server-instruction";
import type { Plan } from "../plan/service";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

const SOURCE = "# Login plan\n\n## Strip rule\n\nA short password has a strip no other shares.\n";

async function opened() {
	let context = await openPlan(SOURCE);
	plans.push(context.plan);
	let told: Array<[string, number]> = [];
	/** Select an option, or write an answer, then Save it as `handle`. */
	async function save(id: string, answer: { option: number } | { text: string }, handle = "ana") {
		let actor = member(handle);
		let entry = Store.get(context.plan.questions, id)!;
		let question = entry.definition.questions[0]!;
		let fork = entry.model.fork() as Question.Model;
		if ("option" in answer) {
			fork.api.val([question.id, "choice"]).set(question.options[answer.option]!.id);
		} else fork.api.str([question.id, "custom"]).ins(0, answer.text);
		await Questions.edit(context.plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(
			context.plan,
			context.server,
			context.plan.id,
			actor.ws,
			{
				kind: "question:submit",
				ts: 0,
				rid: "save",
				id,
				revision: Store.get(context.plan.questions, id)!.revision,
			},
			undefined,
			(answered, generation) => told.push([answered, generation]),
		);
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	}
	return { ...context, told, save };
}

/** A choice the Planner left beside the strip paragraph without waiting for it. */
async function captured(context: Awaited<ReturnType<typeof opened>>) {
	let digests = Room.digests(context.plan.document);
	let result = await Questions.captureDecisions(context.plan, context.server, context.plan.id, {
		revision: context.plan.revision,
		questions: [{
			key: "fix-strip-sentence",
			header: "Fix",
			question: "How should the wrong sentence be fixed?",
			options: [
				{ label: "Start a new run (recommended)", description: "A run makes the fix." },
				{ label: "Edit the sentence only", description: "Faster." },
			],
			multiple: false,
			blocks: [{ index: 2, digest: digests[2]! }],
		}],
	});
	return result.decisions[0]!.id;
}

test("saving a decision the Planner left open hands its answer to the Planner once", async () => {
	let context = await opened();
	let choice = await captured(context);
	let written = await Questions.capture(context.plan, context.server, context.plan.id, {
		key: "run-replacement",
		question: "Should the replacement run keep going?",
	}, { revision: context.plan.revision });

	await context.save(choice, { option: 0 });
	await context.save(written, { text: "Keep it running." });

	expect(context.told).toEqual([[choice, 1], [written, 1]]);
});

test("an answer a turn or a workflow is waiting for reaches it directly and starts no turn", async () => {
	let context = await opened();
	let created = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let blocking = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({
			questions: [{
				header: "Scope",
				question: "Which scope?",
				multiple: false,
				options: [{ label: "Small", description: "" }, { label: "Large", description: "" }],
			}],
		}),
		undefined,
		created[0]!.resolve,
	);
	let workflow = Questions.ask(
		context.plan,
		context.server,
		context.plan.id,
		Questions.identify({
			questions: [{
				header: "Door",
				question: "Which door?",
				multiple: false,
				options: [{ label: "A", description: "" }, { label: "B", description: "" }],
			}],
		}, { verbatim: true }),
		undefined,
		created[1]!.resolve,
	);
	let human = await Questions.capture(context.plan, context.server, context.plan.id, {
		key: "human-question",
		question: "What do we call it?",
	}, { human: "ana" });
	await Promise.all(created.map(item => item.promise));
	let [asked, hosted] = [...context.plan.records.values()]
		.filter(record => record.id !== human)
		.map(record => record.id);

	await context.save(asked!, { option: 0 });
	await context.save(hosted!, { option: 1 });
	await context.save(human, { text: "Strip rule" });

	expect((await blocking)[0]).toMatchObject({ status: "answered", resolver: "ana" });
	expect((await workflow)[0]).toMatchObject({ status: "answered", resolver: "ana" });
	expect(context.told).toEqual([]);
});

test("the turn names the question, the saved answer and who saved it, as data", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 }, "lee");

	let instruction = answerInstruction(context.plan, id, 1)!;

	expect(instruction.handle).toBe("chopin");
	expect(instruction.said).toBe('@lee answered "How should the wrong sentence be fixed?"');
	expect(instruction.text).toContain(JSON.stringify("How should the wrong sentence be fixed?"));
	expect(instruction.text).toContain(JSON.stringify("Start a new run (recommended)"));
	expect(instruction.text).toContain(JSON.stringify("A run makes the fix."));
	expect(instruction.text).toContain("@lee");
	expect(instruction.text).toContain("Act on it now");
	// Its passage has a write-up of its own, so the turn leaves that passage alone.
	expect(instruction.text).toContain("leave that passage");
	expect(instruction.about?.spent?.()).toBe(false);
});

test("a reopened decision's earlier answer is no longer handed over", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 });
	let instruction = answerInstruction(context.plan, id, 1)!;
	let actor = member();
	await Questions.reopen(context.plan, context.server, context.plan.id, actor.ws, {
		kind: "question:reopen",
		ts: 0,
		rid: "reopen",
		id,
	});

	expect(instruction.about?.spent?.()).toBe(true);
	expect(answerInstruction(context.plan, id, 1)).toBeUndefined();
	await context.save(id, { option: 1 });
	expect(context.told).toEqual([[id, 1], [id, 2]]);
	expect(answerInstruction(context.plan, id, 2)?.text)
		.toContain(JSON.stringify("Edit the sentence only"));
});

test("each answer starts one turn, and one that found no Planner starts when a Planner is available", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 });
	let available = false;
	let started: Instruction[] = [];
	let turns = answerTurns({
		start: async (_channelId, compose) => {
			if (!available) return false;
			let instruction = compose(context.plan);
			if (instruction) started.push(instruction);
			return !!instruction;
		},
	});

	await turns.answered(context.plan.id, id, 1);
	expect(started).toEqual([]);
	available = true;
	await turns.pending(context.plan.id);
	await turns.pending(context.plan.id);
	await turns.answered(context.plan.id, id, 1);

	expect(started.map(instruction => instruction.said)).toEqual([
		'@ana answered "How should the wrong sentence be fixed?"',
	]);
});

test("two saves reported together still start a single turn", async () => {
	let context = await opened();
	let id = await captured(context);
	await context.save(id, { option: 0 });
	let release = Promise.withResolvers<void>();
	let started = 0;
	let turns = answerTurns({
		start: async (_channelId, compose) => {
			await release.promise;
			if (compose(context.plan)) started++;
			return true;
		},
	});

	let first = turns.answered(context.plan.id, id, 1);
	let second = turns.answered(context.plan.id, id, 1);
	release.resolve();
	await Promise.all([first, second]);

	expect(started).toBe(1);
});
