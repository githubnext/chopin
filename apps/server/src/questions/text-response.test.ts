import { expect, test } from "bun:test";
import * as Question from "@chopin/question";
import * as room from "../plan/room";
import { openPlan } from "../testing/plan";
import * as Questions from "./service";
import * as Store from "./store";
import { normalizeRecord } from "./records";
import { member, opened, restart, seed } from "./text-response.test-fixtures";

test("text records restore prose and reject options, selections or missing answers", () => {
	let value = seed();
	let option = { id: "approach", label: "Guided task", description: "Try a small action" };
	let definition = value.definition;
	let record = {
		...value.record,
		definition,
		status: "answered",
		choices: [],
		answers: { [value.questionId]: "Use a guided task." },
		history: [{ choices: [], answers: { [value.questionId]: "Use a tour." }, owner: "ana", at: 1 }],
	};
	expect(normalizeRecord(record)).toMatchObject({ origin: "human", history: record.history });
	for (
		let invalid of [
			{ ...record, definition: { questions: [{ ...definition.questions[0], options: [option] }] } },
			{ ...record, choices: [option.id] },
			{ ...record, answers: {} },
			{ ...record, answers: { [value.questionId]: " " } },
			{ ...record, answers: { [value.questionId]: "x".repeat(4001) } },
			{ ...record, history: [{ choices: [option.id], owner: "ana", at: 1 }] },
		]
	) expect(() => normalizeRecord(invalid)).toThrow(/invalid question record/);
	expect(() =>
		normalizeRecord({
			...record,
			definition: { questions: [{ ...definition.questions[0], id: "toString" }] },
			answers: {},
			history: [],
		})
	).toThrow(/invalid question record/);
});

test("the submit claim requires a current nonempty written draft and blocks edits until rollback", () => {
	let value = seed();
	let questions = Store.restore([value.open]);
	expect(Store.claimSubmit(questions, value.id, 0, "ana")).toMatchObject({
		ok: false,
		reason: "invalid",
	});
	let entry = Store.get(questions, value.id)!;
	let fork = entry.model.fork() as Question.Model;
	fork.api.str([value.questionId, "custom"]).ins(0, "Start with a task.");
	let patch = [...fork.api.flush().toBinary()];
	expect(Store.edit(questions, value.id, patch, "ana")).toMatchObject({
		accepted: true,
		revision: 1,
	});
	expect(Store.claimSubmit(questions, value.id, 0, "ben")).toEqual({
		ok: false,
		reason: "stale",
		current: 1,
	});
	let claim = Store.claimSubmit(questions, value.id, 1, "ana");
	if (!claim.ok) throw new Error("submission failed");
	expect(claim.answers).toEqual([{
		question: "How should onboarding work?",
		custom: "Start with a task.",
	}]);
	expect(Store.edit(questions, value.id, patch)).toMatchObject({ accepted: false });
	Store.rollback(questions, claim.claim);
	expect(Store.claimSubmit(questions, value.id, 1, "ben").ok).toBe(true);
});

test("restore rejects a response mismatch between authoritative record and shared draft", async () => {
	let value = seed();
	let choices = { questions: [{ ...value.definition.questions[0] }] };
	delete choices.questions[0]!.response;
	await expect(openPlan(value.source, {
		questions: [value.record],
		openQuestions: [{ ...value.open, definition: choices }],
	})).rejects.toThrow(/records disagree with their drafts/);
});

test("Planner option additions are refused without changing a written card", async () => {
	let context = await opened();
	let result = await Questions.addServerOption(context.plan, context.server, "test", context.id, {
		label: "Guided task",
		origin: "planner",
		rationale: "People learn with a small action.",
	});
	expect(result).toEqual({ ok: false, reason: "invalid" });
	await expect(Questions.revisePlannerCard(context.plan, context.server, "test", context.id, {
		title: "How should people learn the first action?",
		addOptions: [{
			label: "Contextual help",
			rationale: "Explain an action at the moment of use.",
		}],
	})).rejects.toThrow(/option addition was refused/);
	let plan = await restart(context);
	let entry = Store.get(plan.questions, context.id)!;
	expect(entry.definition.questions[0]).toMatchObject({
		response: "text",
		question: "How should onboarding work?",
		options: [],
	});
	expect(Question.read(entry.model, entry.definition)[context.questionId]).toMatchObject({
		mode: "custom",
		custom: "",
		choice: null,
	});
	expect(room.project(plan.document)).toContain('response="text"');
});

test("written resolution, reopen, redecision and discard retain prose history across restart", async () => {
	let context = await opened();
	let actor = member();
	let plan = context.plan;
	for (let answer of ["Start with a task.", "Offer help after the first action."]) {
		let entry = Store.get(plan.questions, context.id)!;
		let fork = entry.model.fork() as Question.Model;
		fork.api.str([context.questionId, "custom"]).ins(0, answer);
		await Questions.edit(plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id: context.id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(plan, context.server, "test", actor.ws, {
			kind: "question:submit",
			ts: 0,
			rid: "submit",
			id: context.id,
			revision: Store.get(plan.questions, context.id)!.revision,
		});
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
		plan = await restart(context, plan);
		expect(plan.records.get(context.id)).toMatchObject({
			status: "answered",
			answers: { [context.questionId]: answer },
			resolver: "ana",
			origin: "human",
		});
		expect(room.project(plan.document)).toContain(`<Answer value="${answer}"`);
		await Questions.reopen(plan, context.server, "test", actor.ws, {
			kind: "question:reopen",
			ts: 0,
			rid: "reopen",
			id: context.id,
		});
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:reopen", ok: true });
		plan = await restart(context, plan);
		expect(room.project(plan.document)).toContain(`<Previous value="${answer}" by="ana"`);
		let reopened = Store.get(plan.questions, context.id)!;
		expect(Question.read(reopened.model, reopened.definition)[context.questionId]).toMatchObject({
			mode: "custom",
			custom: "",
		});
	}
	expect(plan.records.get(context.id)?.history.map(entry => entry.answers?.[context.questionId]))
		.toEqual(["Start with a task.", "Offer help after the first action."]);
	await Questions.discard(plan, context.server, "test", actor.ws, {
		kind: "question:discard",
		ts: 0,
		rid: "discard",
		id: context.id,
	});
	plan = await restart(context, plan);
	expect(plan.records.get(context.id)).toMatchObject({
		status: "discarded",
		history: [{ choices: [] }, { choices: [] }],
	});
	expect(Store.get(plan.questions, context.id)).toBeUndefined();
	expect(room.project(plan.document)).toContain('status="discarded"');
});
