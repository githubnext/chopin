import { expect, test } from "bun:test";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { fixture } from "./initial-card.test-fixtures";

test("an initially empty decision runs one title job then one option suggestion without changing its wording", async () => {
	let h = await fixture();
	let jobs = h.start(async (job, prompt) => {
		if (job.kind === "suggest") {
			expect(prompt).toContain("Review the decision and discussion.");
			expect(prompt).toContain("Options so far:\n(none)");
		}
		let result = await h.generate(
			job,
			job.kind === "suggest"
				? { add_options: [{ label: "GitHub Apps", rationale: "Uses the existing integration." }] }
				: { description: "Keep access aligned with the repository." },
		);
		return { status: "done", output: JSON.stringify(result.output) };
	});
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let card = h.plan.records.get(h.intent.target)!;
	let before = structuredClone(card.definition.questions[0]!);
	expect(before.options).toEqual([]);
	let pending = h.plan.conversationPlanPendingEffects;
	expect(pending).toHaveLength(1);
	let effect = pending[0]!;
	if (effect.kind !== "job") throw new Error("expected initial option suggestion");
	expect(effect).toMatchObject({
		key: `job:suggest:${card.id}:initial`,
		threadId: h.intent.threadId,
		intent: { kind: "suggest", target: card.id, trigger: h.source.messageId },
	});
	await jobs.enqueue(effect.intent, effect.key);
	await jobs.idle();
	await jobs.enqueue(effect.intent, effect.key);
	await jobs.idle();
	expect(h.runnerCalls()).toBe(2);
	expect(jobs.jobs().map(job => [job.kind, job.status])).toEqual([
		["refine", "done"],
		["suggest", "done"],
	]);
	let question = h.plan.records.get(card.id)!.definition.questions[0]!;
	expect(question).toMatchObject({
		id: before.id,
		question: before.question,
		description: before.description,
		options: [{ label: "GitHub Apps" }],
	});
	expect(h.plan.records.get(card.id)!.optionOrigins[question.options[0]!.id]?.origin)
		.toBe("planner");
	expect(h.plan.conversationPlanPendingEffects).toEqual([]);
	expect(h.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(1);
	jobs.stop();
	await Service.close(h.plan);
	let restored = await Service.open(h.channel.id, h.backend, h.server);
	try {
		expect(restored.records.size).toBe(1);
		expect(restored.conversationPlanPendingEffects).toEqual([]);
		expect(restored.conversationPlanEffects).toContain(effect.key);
		expect(restored.conversationPlanJobs.map(job => job.kind)).toEqual(["refine", "suggest"]);
	} finally {
		await Service.close(restored);
	}
});

test("a failed initial suggestion leaves the created card intact and can retry the same job", async () => {
	let h = await fixture();
	let fail = true;
	let jobs = h.start(async job => {
		if (job.kind === "suggest" && fail) throw new Error("Planner suggestion unavailable");
		let result = await h.generate(job);
		return { status: "done", output: JSON.stringify(result.output) };
	});
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let before = room.project(h.plan.document);
	let effect = h.plan.conversationPlanPendingEffects[0]!;
	if (effect.kind !== "job") throw new Error("expected initial option suggestion");
	await jobs.enqueue(effect.intent, effect.key);
	await jobs.idle();
	let failed = jobs.jobs().find(job => job.kind === "suggest")!;
	expect(failed).toMatchObject({ status: "failed", target: h.intent.target });
	expect(failed.reason).toContain("Planner suggestion unavailable");
	expect(h.plan.records.size).toBe(1);
	expect(room.project(h.plan.document)).toBe(before);
	expect(h.plan.conversationPlan.threads[0]?.questionnaireId).toBe(h.intent.target);
	fail = false;
	expect(await jobs.retry(failed.id)).toBe(true);
	await jobs.idle();
	expect(jobs.jobs().find(job => job.kind === "suggest"))
		.toMatchObject({ id: failed.id, status: "done", attempts: 2 });
	expect(h.plan.records.size).toBe(1);
	expect(h.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(1);
});

test("suggestion enqueue failure retains its durable intent without rerunning initial generation", async () => {
	let h = await fixture();
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let effect = h.plan.conversationPlanPendingEffects[0]!;
	if (effect.kind !== "job") throw new Error("expected initial option suggestion");
	let commit = h.storage.collaboration.commit;
	h.storage.collaboration.commit = async () => {
		throw new Error("suggest enqueue rejected");
	};
	await expect(jobs.enqueue(effect.intent, effect.key)).rejects.toThrow("suggest enqueue rejected");
	expect(h.plan.conversationPlanPendingEffects).toEqual([effect]);
	expect(jobs.jobs().map(job => job.kind)).toEqual(["refine"]);
	expect(h.plan.records.size).toBe(1);
	h.storage.collaboration.commit = commit;
	await jobs.enqueue(effect.intent, effect.key);
	await jobs.idle();
	expect(h.runnerCalls()).toBe(2);
	expect(jobs.jobs().map(job => [job.kind, job.status])).toEqual([
		["refine", "done"],
		["suggest", "done"],
	]);
});
