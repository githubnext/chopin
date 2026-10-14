import { afterEach } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { applyEvent } from "../conversation-plan/events";
import { effectsFor } from "../conversation-plan/effects";
import { createPlannerJobs, type PlannerJobRunner } from "../conversation-plan/planner-jobs";
import { PROMPT_FOR } from "../conversation-plan/job-prompts";
import { refineDecision } from "./refine-tool";
import type { ConversationPlan } from "@chopin/protocol";

export let quote =
	"Which authentication system should we use for the shared document, considering the existing GitHub integration and the teams who need access?";
let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];
let services: ReturnType<typeof createPlannerJobs>[] = [];
afterEach(async () => {
	for (let service of services) {
		service.stop();
		await service.idle();
	}
	for (let context of contexts) {
		if (!context.plan.persistence.closing) await Service.close(context.plan);
	}
	contexts = [];
	services = [];
});

export async function fixture() {
	let context = await openPlan("Opening prose.\n\nLater prose.\n");
	contexts.push(context);
	let { plan } = context;
	let source: ConversationPlan.SourceRef = {
		messageId: "message",
		author: { kind: "member", handle: "test" },
		quote,
		start: 0,
		end: quote.length,
		role: "question",
	};
	plan.chat.entries.push({ id: source.messageId, author: source.author, text: quote, ts: 1 });
	let event: ConversationPlan.Event = {
		id: "opening",
		type: "thread.opened",
		threadId: "thread:with:colons",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
		question: quote,
		source,
	};
	plan.conversationPlan = applyEvent(plan.conversationPlan, event);
	let effect = effectsFor([event], plan.conversationPlan)[0]!;
	plan.conversationPlanPendingEffects = [effect];
	await Service.persist(plan);
	let intent = {
		kind: "refine" as const,
		target: ulid(),
		threadId: event.threadId,
		trigger: event.id,
	};
	let errors: unknown[] = [];
	let runnerCalls = 0;
	async function generate(job: ConversationPlan.Job, args: Record<string, unknown> = {}) {
		plan.chat.job = job;
		return refineDecision(
			{
				plan,
				server: context.server,
				room: plan.id,
				exclusive: action => Service.exclusive(plan, action),
				anchors() {},
				changes() {},
			},
			job,
			plan.chat.turn,
			{
				revision: plan.revision,
				id: job.target,
				...(job.kind === "refine" ? { title: "Which authentication system should we use?" } : {}),
				...args,
			},
		);
	}
	function start(runner?: PlannerJobRunner) {
		let service = createPlannerJobs({
			plan,
			exclusive: action => Service.exclusive(plan, action),
			persist: () => Service.persistExclusive(plan),
			runner: async (job, prompt, signal) => {
				runnerCalls++;
				if (runner) return runner(job, prompt, signal);
				let result = await generate(job);
				return { status: "done", output: JSON.stringify(result.output) };
			},
			prompt: job => PROMPT_FOR[job.kind]?.(plan, job),
			publishJobs() {},
			publishMeta() {},
			activity: () => Service.persistExclusive(plan),
			onError: error => errors.push(error),
		});
		services.push(service);
		return service;
	}
	async function saved() {
		let loaded = (await context.storage.collaboration.load(plan.id, context.now))!;
		return (loaded.sidecar ?? loaded.snapshot!.sidecar) as unknown as {
			questions: unknown[];
			openQuestions: unknown[];
			conversationPlan: ConversationPlan.State;
			conversationPlanJobs: ConversationPlan.Job[];
			conversationPlanEffects: string[];
			conversationPlanPendingEffects?: unknown[];
		};
	}
	return {
		...context,
		intent,
		effect,
		start,
		generate,
		errors,
		saved,
		source,
		runnerCalls: () => runnerCalls,
	};
}
