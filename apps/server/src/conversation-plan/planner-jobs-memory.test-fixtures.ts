import { expect } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { interpretMessage } from "./interpret";
import { mockResult } from "./interpret.test-fixtures";
import { createProcessor } from "./service";
import { createPlannerJobs, type PlannerJobRunner } from "./planner-jobs";
import { PROMPT_FOR } from "./job-prompts";

function allowCommit(): boolean {
	return false;
}

async function unsupported(): Promise<never> {
	throw new Error("unexpected card effect");
}

export async function memoryJobs() {
	let context = await openPlan();
	let plan = context.plan;
	let errors: unknown[] = [];
	let publications: ConversationPlan.Job[][] = [];
	let jobs: ReturnType<typeof createPlannerJobs> | undefined;
	let processor: ReturnType<typeof createProcessor> | undefined;
	let original = context.storage.collaboration.commit;
	let reject: (input: Parameters<typeof original>[0]) => boolean = allowCommit;
	context.backend.fatal = error => errors.push(error);
	plan.persistence.fatal = context.backend.fatal;
	context.storage.collaboration.commit = async input => {
		if (reject(input)) throw new Error("memory commit rejected");
		return original(input);
	};
	async function saved() {
		let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
		return (loaded.sidecar ?? loaded.snapshot!.sidecar) as unknown as {
			transcript: typeof plan.chat.entries;
			conversationPlan: ConversationPlan.State;
			conversationPlanJobs?: ConversationPlan.Job[];
			conversationPlanEffects?: string[];
			conversationPlanPendingEffects?: unknown[];
		};
	}
	function start(runner: PlannerJobRunner) {
		let captured = plan;
		let committedJobs = structuredClone(captured.conversationPlanJobs);
		let committedState = structuredClone(captured.conversationPlan);
		function exclusive<T>(action: () => Promise<T>) {
			return Plan.exclusive(captured, action);
		}
		let persist = async () => {
			await Plan.persistExclusive(captured);
			let sidecar = await saved();
			committedJobs = sidecar.conversationPlanJobs ?? [];
			committedState = sidecar.conversationPlan;
		};
		jobs = createPlannerJobs({
			plan: captured,
			exclusive,
			persist,
			runner,
			prompt: job => PROMPT_FOR[job.kind]?.(captured, job),
			publishJobs: current => {
				expect(current).toEqual(committedJobs);
				publications.push(structuredClone(current));
			},
			publishMeta: () => {
				throw new Error("unexpected card job");
			},
			activity: async text => {
				let before = captured.chat.entries;
				captured.chat.entries = [...before, {
					id: crypto.randomUUID(),
					author: { kind: "system" },
					text,
					ts: 2,
				}];
				try {
					await persist();
				} catch (error) {
					captured.chat.entries = before;
					throw error;
				}
			},
			onCapacityAvailable: () => processor?.wake(),
			onError: error => errors.push(error),
		});
		let coordinator = jobs;
		processor = createProcessor({
			plan: captured,
			exclusive,
			persist,
			active: () => true,
			publish: state => expect(state).toEqual(committedState),
			interpret: input =>
				interpretMessage({
					...input,
					ask: async request => mockResult(request.questions, { enough_purpose: 0.9 }),
				}),
			effects: {
				target: () => ({ kind: "unlinked" }),
				insertCard: unsupported,
				link: unsupported,
				addOption: unsupported,
				suggest: unsupported,
				prompt: unsupported,
				enqueueJob: coordinator.enqueue,
				report: error => errors.push(error),
			},
			onError: error => errors.push(error),
		});
		return { jobs: coordinator, processor };
	}
	async function close() {
		processor?.stop();
		jobs?.stop();
		await jobs?.idle();
		await Plan.close(plan);
	}
	return {
		get plan() {
			return plan;
		},
		start,
		saved,
		publications,
		errors,
		rejectCommits(check: typeof reject) {
			reject = check;
		},
		async reopen() {
			await close();
			plan = await Plan.open(context.channel.id, context.backend, context.server);
		},
		close,
	};
}

export let message = {
	id: "purpose",
	author: { kind: "member" as const, handle: "ana" },
	text: "We need to figure out our authentication approach.",
	ts: 1,
};
