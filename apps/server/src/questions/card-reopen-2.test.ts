import { expect, test } from "bun:test";
import * as Question from "@chopin/question";
import * as room from "../plan/room";
import * as Service from "../plan/service";

import * as Questions from "./service";
import * as Store from "./store";

import { decided, definition, member, plans, reopen } from "./card-reopen.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("a queued implementation claim refuses reopen before any state changes", async () => {
	let context = await decided();
	let actor = member();
	let before = room.project(context.plan.document);
	let gate = Service.exclusive(context.plan, async () => {
		context.plan.execution = { id: "run-1" } as never;
	});
	let pending = reopen(context, actor);
	await Promise.all([gate, pending]);
	expect(actor.frames.at(-1)).toMatchObject({
		kind: "session:error",
		message: "implementation is active",
	});
	expect(context.plan.records.get(context.id)?.status).toBe("answered");
	expect(room.project(context.plan.document)).toBe(before);
	context.plan.execution = undefined;
});

test("legacy multi-question custom and ID answers survive reopen, restart, and redecision", async () => {
	let value = definition(2);
	let first = value.questions[0]!;
	let second = value.questions[1]!;
	let context = await decided(value, {
		[first.id]: "Option 1",
		[second.id]: "Use our existing provider",
	}, [first.options[0]!.id]);
	await reopen(context);
	let record = context.plan.records.get(context.id)!;
	expect(record.history[0]).toEqual({
		choices: [first.options[0]!.id],
		answers: { [second.id]: "Use our existing provider" },
		owner: "ana",
		at: 1,
	});
	let projected = room.project(context.plan.document);
	expect(projected).toContain(`<Previous value="Use our existing provider" by="ana"`);
	expect(projected).not.toContain('<Previous choices=""');
	await Service.close(context.plan);
	plans.splice(plans.indexOf(context.plan), 1);
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(plan);
	expect(Store.snapshot(plan.questions, context.id)).toMatchObject({
		open: true,
		definition: value,
	});
	let snapshot = Store.snapshot(plan.questions, context.id);
	if (!snapshot.open) throw new Error("missing restored draft");
	let model = Question.crdt.Model.fromBinary(new Uint8Array(snapshot.model))
		.fork() as unknown as Question.Model;
	model.api.val([first.id, "choice"]).set(first.options[0]!.id);
	model.api.val([second.id, "choice"]).set(second.options[0]!.id);
	let patch = model.api.flush();
	let actor = member("cy");
	await Questions.edit(plan, actor.ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
		id: context.id,
		patch: [...patch.toBinary()],
	});
	await Questions.submit(plan, context.server, "test", actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: Store.get(plan.questions, context.id)!.revision,
	});
	expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	expect(room.project(plan.document)).toContain('<Previous value="Use our existing provider"');
	await Service.close(plan);
	plans.splice(plans.indexOf(plan), 1);
	let again = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(again);
	expect(again.records.get(context.id)).toMatchObject({
		status: "answered",
		history: [{ answers: { [second.id]: "Use our existing provider" } }],
	});
});

test("legacy multi-select history accepts more than 20 chosen IDs through restart and Save", async () => {
	let value = Questions.identify({
		questions: [0, 1].map(index => ({
			header: `Set ${index + 1}`,
			question: `Which options belong in set ${index + 1}?`,
			multiple: true,
			options: Array.from({ length: 11 }, (_, position) => ({
				label: `Choice ${index + 1}-${position + 1}`,
				description: "",
			})),
		})),
	});
	let ids = value.questions.flatMap(question => question.options.map(option => option.id));
	let answers = Object.fromEntries(value.questions.map(question => [
		question.id,
		question.options.map(option => option.label).join(", "),
	]));
	let context = await decided(value, answers, ids);
	await reopen(context);
	expect(context.plan.records.get(context.id)?.history[0]?.choices).toHaveLength(22);
	await Service.close(context.plan);
	plans.splice(plans.indexOf(context.plan), 1);
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(plan);
	let snapshot = Store.snapshot(plan.questions, context.id);
	if (!snapshot.open) throw new Error("missing restored draft");
	let model = Question.crdt.Model.fromBinary(new Uint8Array(snapshot.model))
		.fork() as unknown as Question.Model;
	for (let question of value.questions) {
		for (let option of question.options) {
			model.api.val([question.id, "options", option.id]).set(true);
		}
	}
	let patch = model.api.flush();
	let actor = member("cy");
	await Questions.edit(plan, actor.ws, {
		kind: "question:edit",
		ts: 0,
		rid: "edit",
		id: context.id,
		patch: [...patch.toBinary()],
	});
	await Questions.submit(plan, context.server, "test", actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id: context.id,
		revision: Store.get(plan.questions, context.id)!.revision,
	});
	expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	await Service.close(plan);
	plans.splice(plans.indexOf(plan), 1);
	let again = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(again);
	expect(again.records.get(context.id)?.history[0]?.choices).toHaveLength(22);
	expect(again.records.get(context.id)?.choices).toHaveLength(22);
});
