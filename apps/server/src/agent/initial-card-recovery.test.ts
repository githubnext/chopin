import { expect, test } from "bun:test";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as room from "../plan/room";
import * as Store from "../questions/store";
import * as Jobs from "../conversation-plan/jobs";
import { fixture } from "./initial-card.test-fixtures";

test("enqueue failure retains the insertion effect and commits no job or card", async () => {
	let h = await fixture();
	let commit = h.storage.collaboration.commit;
	h.storage.collaboration.commit = async () => {
		throw new Error("enqueue rejected");
	};
	let jobs = h.start();
	await expect(jobs.enqueue(h.intent, h.effect.key)).rejects.toThrow("enqueue rejected");
	expect(h.plan.conversationPlanPendingEffects).toEqual([h.effect]);
	expect(h.plan.conversationPlanEffects).toEqual([]);
	expect(jobs.jobs()).toEqual([]);
	expect(h.plan.records.size).toBe(0);
	expect(h.broadcasts.some(frame => frame.kind === "question:asked")).toBe(false);
	h.storage.collaboration.commit = commit;
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	expect(h.plan.records.size).toBe(1);
});

test("failed card commit publishes no record, draft, projection, or link and retries the reserved ID", async () => {
	let h = await fixture();
	let commit = h.storage.collaboration.commit;
	let reject = true;
	h.storage.collaboration.commit = async input => {
		if (reject && (input.sidecar as { questions?: unknown[] })?.questions?.length) {
			reject = false;
			throw new Error("card commit rejected");
		}
		return commit(input);
	};
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let failed = jobs.jobs()[0]!;
	expect(failed.status).toBe("failed");
	expect(failed.reason).toContain("card commit rejected");
	expect(h.plan.records.size).toBe(0);
	expect(h.plan.questions.open.size).toBe(0);
	expect(h.plan.conversationPlan.threads[0]?.questionnaireId).toBeUndefined();
	expect(room.project(h.plan.document)).not.toContain("<Questionnaire");
	expect(h.broadcasts.some(frame => frame.kind === "question:asked")).toBe(false);
	let saved = await h.saved();
	expect(saved.questions).toEqual([]);
	expect(saved.openQuestions).toEqual([]);
	expect(saved.conversationPlanPendingEffects ?? []).toEqual([]);
	expect(h.plan.conversationPlanPendingEffects).toEqual([]);
	await jobs.retry(failed.id);
	await jobs.idle();
	expect(jobs.jobs()[0]).toMatchObject({
		id: failed.id,
		target: failed.target,
		status: "done",
		attempts: 2,
	});
	expect([...h.plan.records.keys()]).toEqual([failed.target]);
});

test("creation survives a crash before job settlement and retry does not run the model or duplicate the card", async () => {
	let h = await fixture();
	let commit = h.storage.collaboration.commit;
	let reject = true;
	h.storage.collaboration.commit = async input => {
		let jobs = (input.sidecar as { conversationPlanJobs?: Jobs.Job[] })?.conversationPlanJobs;
		if (reject && jobs?.[0]?.status === "done") {
			reject = false;
			throw new Error("settle rejected");
		}
		return commit(input);
	};
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	expect(jobs.jobs()[0]?.status).toBe("running");
	expect(h.plan.records.size).toBe(1);
	let saved = await h.saved();
	expect(saved.questions).toHaveLength(1);
	expect(saved.conversationPlan.threads[0]?.questionnaireId).toBe(h.intent.target);
	h.plan.conversationPlanJobs = Jobs.restore(saved.conversationPlanJobs);
	await jobs.retry(h.plan.conversationPlanJobs[0]!.id);
	await jobs.idle();
	expect(h.runnerCalls()).toBe(1);
	expect(h.plan.records.size).toBe(1);
	expect(jobs.jobs()[0]?.status).toBe("done");
	expect(h.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(1);
	jobs.stop();
	await Service.close(h.plan);
	let restored = await Service.open(h.channel.id, h.backend, h.server);
	try {
		expect(restored.records.size).toBe(1);
		expect(restored.conversationPlanPendingEffects).toMatchObject([{
			key: `job:suggest:${h.intent.target}:initial`,
			kind: "job",
			intent: { kind: "suggest", target: h.intent.target, trigger: h.source.messageId },
		}]);
		expect(restored.conversationPlanJobs).toHaveLength(1);
	} finally {
		await Service.close(restored);
	}
});

test("live Planner queue capacity rejection remains retryable with the same reserved identity", async () => {
	let h = await fixture();
	let full = true;
	let jobs = h.start(async job => {
		if (full) return { status: "skipped", reason: "The Planner queue is full." };
		let result = await h.generate(job);
		return { status: "done", output: JSON.stringify(result.output) };
	});
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	let failed = jobs.jobs()[0]!;
	expect(failed).toMatchObject({ status: "failed", target: h.intent.target });
	expect(h.plan.records.size).toBe(0);
	full = false;
	await jobs.retry(failed.id);
	await jobs.idle();
	expect(jobs.jobs()[0]).toMatchObject({ id: failed.id, status: "done" });
	expect([...h.plan.records.keys()]).toEqual([h.intent.target]);
});

test("legacy card committed before its link is adopted with its original identity and wording", async () => {
	let h = await fixture();
	let id = await Questions.insertConversationCard(h.plan, h.server, h.plan.id, {
		threadId: h.intent.threadId,
		header: "Auth",
		question: "Existing question?",
		options: [],
	});
	let record = h.plan.records.get(id)!;
	let legacy = "An exact old question ".repeat(12).trim() + "?";
	record.definition.questions[0]!.question = legacy;
	let live = Store.get(h.plan.questions, id)!;
	live.definition = structuredClone(record.definition);
	room.projectPrompt(h.plan.document, id, record.definition.questions[0]!.id, legacy);
	await Service.persist(h.plan);
	let before = room.project(h.plan.document);
	let jobs = h.start();
	await jobs.enqueue(h.intent, h.effect.key);
	await jobs.idle();
	expect(jobs.jobs()[0]).toMatchObject({ target: id, status: "done" });
	expect(h.plan.conversationPlan.threads[0]?.questionnaireId).toBe(id);
	expect(h.plan.records.size).toBe(1);
	expect(h.plan.conversationPlanPendingEffects).toMatchObject([{
		key: `job:suggest:${id}:initial`,
		kind: "job",
		intent: { kind: "suggest", target: id, trigger: h.source.messageId },
	}]);
	expect(room.project(h.plan.document)).toBe(before);
	expect(h.plan.records.get(id)?.definition.questions[0]?.question).toBe(legacy);
	let stored = (await h.storage.collaboration.load(h.plan.id, h.now))!;
	await expect(Service.readStored(stored)).resolves.toBeDefined();
});
