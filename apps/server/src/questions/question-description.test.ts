import { expect, test } from "bun:test";
import * as Question from "@chopin/question";
import { openPlan } from "../testing/plan";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./card-reopen.test-fixtures";
import { definition, draft, legacyRecord } from "../plan/question-record.test-fixtures";

let description = "Session data must survive a server restart.";

test("supporting context survives ask, retitle, answer, reopen and persistent restore", async () => {
	let context = await openPlan("");
	let plan = context.plan;
	let pending: Promise<unknown> | undefined;
	try {
		let value = Questions.identify({
			questions: [{
				header: "Sessions",
				question: "Where should we store sessions?",
				description,
				multiple: false,
				options: [{ label: "PostgreSQL", description: "Durable" }],
			}],
		});
		let ready = Promise.withResolvers<void>();
		pending = Questions.ask(plan, context.server, "test", value, undefined, ready.resolve);
		await ready.promise;
		let [id, record] = [...plan.records][0]!;
		let question = record.definition.questions[0]!;
		expect(question.description).toBe(description);
		expect(Room.project(plan.document)).toContain(`description="${description}"`);
		expect(
			await Questions.retitle(
				plan,
				context.server,
				"test",
				id,
				"Which session store should we use?",
			),
		)
			.toMatchObject({ ok: true });
		let entry = Store.get(plan.questions, id)!;
		let model = Question.crdt.Model.fromBinary(entry.model.toBinary())
			.fork() as unknown as Question.Model;
		model.api.val([question.id, "choice"]).set(question.options[0]!.id);
		let patch = model.api.flush()!;
		Store.edit(plan.questions, id, [...patch.toBinary()], "ana");
		await Questions.submit(plan, context.server, "test", member("ana").ws, {
			kind: "question:submit",
			ts: 0,
			rid: "answer",
			id,
			revision: Store.get(plan.questions, id)!.revision,
		});
		await pending;
		expect(plan.records.get(id)?.status).toBe("answered");
		expect(Room.project(plan.document)).toContain(`description="${description}"`);
		await Questions.reopen(plan, context.server, "test", member("ana").ws, {
			kind: "question:reopen",
			ts: 0,
			rid: "reopen",
			id,
		});
		expect(plan.records.get(id)?.definition.questions[0]?.description).toBe(description);
		await Service.close(plan);
		plan = await Service.open(context.channel.id, context.backend, context.server);
		expect(plan.records.get(id)?.definition.questions[0]?.description).toBe(description);
		expect(Store.get(plan.questions, id)?.definition.questions[0]?.description).toBe(description);
		expect(Room.project(plan.document)).toContain(`description="${description}"`);
	} finally {
		await Service.close(plan);
		await pending;
	}
});

test("stored record and shared draft descriptions must match", async () => {
	let value = definition();
	value.questions[0]!.description = description;
	let other = structuredClone(value);
	other.questions[0]!.description = "Different context.";
	await expect(openPlan("", { questions: [legacyRecord(value)], openQuestions: [draft(other)] }))
		.rejects.toThrow();
});

test("legacy long questions retain their exact stored prompt through restore", async () => {
	let value = definition();
	value.questions[0]!.question = "x".repeat(1000);
	let context = await openPlan("", {
		questions: [legacyRecord(value)],
		openQuestions: [draft(value)],
	});
	try {
		expect(context.plan.records.get("saved-card")?.definition.questions[0]?.question)
			.toBe(value.questions[0]!.question);
	} finally {
		await Service.close(context.plan);
	}
});
