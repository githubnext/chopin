import { describe, expect, test } from "bun:test";
import { type Effect, runEffects } from "./effects";
import { harness } from "./planner-jobs.test-fixtures";

describe("createPlannerJobs", () => {
	test("a failed prose enqueue stays in the closed card outbox for a later wake", async () => {
		let ran = 0;
		let h = harness(async () => {
			ran++;
			return { status: "done", output: JSON.stringify({ title: "Decision" }) };
		}, { failPersist: attempt => attempt === 1 });
		h.plan.records.set("W1", {
			id: "W1",
			status: "answered",
			origin: "conversation",
			threadId: "t1",
			owner: "ana",
			decidedAt: 1,
			history: [],
			definition: { questions: [{ question: "Decision", options: [] }] },
		} as never);
		let intent = { kind: "prose" as const, target: "W1", trigger: "decided:W1:1" };
		let effect: Effect = { key: "job:prose:W1:1", kind: "job", threadId: "t1", intent };
		h.plan.conversationPlanPendingEffects = [effect];
		let reported: unknown[] = [];
		let deps = {
			applied: (key: string) => h.plan.conversationPlanEffects.includes(key),
			markApplied: async () => {},
			target: () => ({ kind: "closed" as const }),
			proseReady: (thread: string, id: string, trigger: string) =>
				thread === "t1" && id === "W1" && trigger === intent.trigger,
			insertCard: async () => "W1",
			link: async () => {},
			addOption: async () => {},
			suggest: async () => {},
			prompt: async () => {},
			enqueueJob: h.service.enqueue,
			report: (error: unknown) => reported.push(error),
		};
		expect(await runEffects(deps, [effect])).toBe(0);
		expect(h.plan.conversationPlanPendingEffects).toEqual([effect]);
		expect(h.plan.conversationPlanEffects).toEqual([]);
		expect(h.service.jobs()).toEqual([]);
		expect(reported).toHaveLength(1);
		expect(await runEffects(deps, [effect])).toBe(1);
		await h.service.idle();
		expect(h.plan.conversationPlanPendingEffects).toEqual([]);
		expect(h.plan.conversationPlanEffects).toEqual([effect.key]);
		expect(h.service.jobs()[0]?.status).toBe("done");
		expect(ran).toBe(1);
	});

	test("a keyed enqueue rejects an unknown or mismatched pending effect", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }));
		let intent = { kind: "refine" as const, target: "W1", trigger: "m1" };
		await expect(h.service.enqueue(intent, "missing")).rejects.toThrow("pending job effect");
		h.plan.conversationPlanPendingEffects = [{
			key: "job:suggest:W1:e1",
			kind: "job",
			intent: {
				kind: "suggest",
				target: "W1",
				trigger: "m1",
			},
		}];
		await expect(h.service.enqueue(intent, "job:suggest:W1:e1"))
			.rejects.toThrow("pending job effect");
		h.plan.conversationPlanPendingEffects = [{
			key: "job:refine:W1:e2",
			kind: "job",
			intent: {
				kind: "refine",
				target: "W1",
				trigger: "different-message",
			},
		}];
		await expect(h.service.enqueue(intent, "job:refine:W1:e2"))
			.rejects.toThrow("pending job effect");
		expect(h.commits).toEqual([]);
	});

	test("legacy event triggers become source message IDs in durable job records", async () => {
		let h = harness(async () => ({ status: "done", output: "{}" }));
		h.plan.conversationPlan.threads = [{
			id: "t1",
			questionnaireId: "W1",
			questionSources: [{ messageId: "question-message" }],
		}];
		h.plan.conversationPlan.events = [{
			id: "card-event",
			type: "card.linked",
			threadId: "t1",
			questionnaireId: "W1",
		}, {
			id: "option-event",
			type: "option.added",
			threadId: "t1",
			source: { messageId: "option-message" },
		}];
		let refine = { kind: "refine" as const, target: "W1", trigger: "card-event" };
		h.plan.conversationPlanPendingEffects = [{
			key: "job:refine:W1:card-event",
			kind: "job",
			threadId: "t1",
			intent: refine,
		}];
		await h.service.enqueue(refine, "job:refine:W1:card-event");
		await h.service.idle();
		expect(h.service.jobs()[0]).toMatchObject({
			id: "refine:W1:question-message",
			trigger: "question-message",
			status: "done",
		});
		let suggest = { kind: "suggest" as const, target: "W1", trigger: "option-event" };
		h.plan.conversationPlanPendingEffects = [{
			key: "job:suggest:W1:option-event",
			kind: "job",
			threadId: "t1",
			intent: suggest,
		}];
		await h.service.enqueue(suggest, "job:suggest:W1:option-event");
		await h.service.idle();
		expect(h.service.jobs()[1]).toMatchObject({
			id: "suggest:W1:option-message",
			trigger: "option-message",
			status: "done",
		});
		expect(h.plan.conversationPlanEffects).toEqual([
			"job:refine:W1:card-event",
			"job:suggest:W1:option-event",
		]);
	});
});
