import { expect, test } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { applyEvent } from "../conversation-plan/events";
import { fixture, quote } from "./initial-card.test-fixtures";

test("initial title generation publishes no partial card and keeps exact sources and concurrent options", async () => {
	let h = await fixture();
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let jobs = h.start(async (job, prompt) => {
		if (job.kind === "suggest") {
			let result = await h.generate(job, {
				add_options: [
					{ label: "GitHub Apps", rationale: "Already proposed by the member." },
					{ label: "OAuth", rationale: "An alternative integration approach." },
				],
			});
			return { status: "done", output: JSON.stringify(result.output) };
		}
		expect(prompt).toContain(quote);
		expect(prompt).toContain("Do not supply add_options");
		entered.resolve();
		await release.promise;
		let result = await h.generate(job, {
			description: "Use the existing GitHub integration where possible.",
			place_after: { index: 0, digest: room.digests(h.plan.document)[0] },
		});
		return { status: "done", output: JSON.stringify(result.output) };
	});
	await jobs.enqueue(h.intent, h.effect.key);
	await entered.promise;
	expect(h.plan.records.size).toBe(0);
	expect(h.plan.questions.open.size).toBe(0);
	expect(room.project(h.plan.document)).not.toContain("<Questionnaire");
	expect(h.plan.chat.entries.some(entry => entry.decision)).toBe(false);
	let stored = await h.saved();
	expect(stored.questions).toEqual([]);
	expect(stored.openQuestions).toEqual([]);
	expect(stored.conversationPlanJobs[0]).toMatchObject({
		target: h.intent.target,
		threadId: h.intent.threadId,
		trigger: "message",
	});
	expect(stored.conversationPlanEffects).toContain(h.effect.key);
	expect(stored.conversationPlanPendingEffects ?? []).toEqual([]);
	let optionId = ulid();
	let text = "GitHub Apps";
	await Service.exclusive(h.plan, async () => {
		h.plan.chat.entries.push({ id: "option-message", author: h.source.author, text, ts: 2 });
		h.plan.conversationPlan = applyEvent(h.plan.conversationPlan, {
			id: "option-event",
			type: "option.added",
			threadId: h.intent.threadId,
			observedThreadVersion: 1,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: 2,
			source: {
				...h.source,
				messageId: "option-message",
				quote: text,
				end: text.length,
				role: "option",
			},
			contribution: { id: optionId, text, authoring: "quoted" },
		});
		await Service.persistExclusive(h.plan);
	});
	release.resolve();
	await jobs.idle();
	expect(jobs.jobs()[0]).toMatchObject({ status: "done" });
	let record = h.plan.records.get(h.intent.target)!;
	expect(record.definition.questions[0]).toMatchObject({
		question: "Which authentication system should we use?",
		description: "Use the existing GitHub integration where possible.",
		options: [{ id: optionId, label: text }],
	});
	expect(record.optionOrigins[optionId]?.source?.quote).toBe(text);
	expect(h.plan.conversationPlan.threads[0]).toMatchObject({
		question: quote,
		questionSources: [h.source],
		questionnaireId: record.id,
	});
	expect(h.plan.conversationPlanPendingEffects).toMatchObject([{
		kind: "job",
		intent: { kind: "suggest", target: record.id, trigger: h.source.messageId },
	}]);
	expect(h.plan.conversationPlanJobs).toHaveLength(1);
	expect(room.project(h.plan.document).indexOf("<Questionnaire")).toBeLessThan(
		room.project(h.plan.document).indexOf("Later prose"),
	);
	expect(h.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(1);
	let saved = await h.saved();
	expect(saved.conversationPlan.threads[0]?.questionnaireId).toBe(record.id);
	expect(saved.questions).toHaveLength(1);
	let effect = h.plan.conversationPlanPendingEffects[0]!;
	if (effect.kind !== "job") throw new Error("expected initial option suggestion");
	let origin = structuredClone(record.optionOrigins[optionId]);
	await jobs.enqueue(effect.intent, effect.key);
	await jobs.idle();
	let augmented = h.plan.records.get(record.id)!;
	expect(augmented.definition.questions[0]!.options).toMatchObject([
		{ id: optionId, label: text },
		{ label: "OAuth" },
	]);
	expect(augmented.optionOrigins[optionId]).toEqual(origin);
	expect(h.plan.conversationPlan.threads[0]!.questionSources).toEqual([h.source]);
	expect(h.runnerCalls()).toBe(2);
});

for (
	let args of [
		{ title: "x".repeat(101) },
		{ description: "x".repeat(301) },
		{ title: undefined },
		{ add_options: [{ label: "Model option", rationale: "Invented choice" }] },
	]
) {
	test(`invalid initial wording publishes nothing: ${Object.keys(args)[0]}`, async () => {
		let h = await fixture();
		let jobs = h.start(async job => {
			await h.generate(job, args);
			return { status: "done", output: "{}" };
		});
		await jobs.enqueue(h.intent, h.effect.key);
		await jobs.idle();
		expect(jobs.jobs()[0]?.status).toBe("failed");
		expect(h.plan.records.size).toBe(0);
		expect(h.plan.questions.open.size).toBe(0);
		expect(room.project(h.plan.document)).not.toContain("<Questionnaire");
		expect(h.plan.conversationPlan.threads[0]?.questionnaireId).toBeUndefined();
		expect(h.broadcasts.some(frame => frame.kind === "question:asked")).toBe(false);
	});
}

for (let status of ["discarded", "decided", "implementation"] as const) {
	test(`${status} before publication prevents creation`, async () => {
		let h = await fixture();
		let jobs = h.start(async job => {
			if (status === "implementation") h.plan.execution = { id: "active" } as never;
			else h.plan.conversationPlan.threads[0]!.status = status;
			await h.generate(job);
			return { status: "done", output: "{}" };
		});
		await jobs.enqueue(h.intent, h.effect.key);
		await jobs.idle();
		expect(h.plan.records.size).toBe(0);
		expect(h.plan.questions.open.size).toBe(0);
		expect(room.project(h.plan.document)).not.toContain("<Questionnaire");
		expect(jobs.jobs()[0]?.status).toBe(status === "implementation" ? "failed" : "skipped");
		h.plan.execution = undefined;
		if (status !== "implementation") h.plan.conversationPlan.threads[0]!.status = "exploring";
	});
}
