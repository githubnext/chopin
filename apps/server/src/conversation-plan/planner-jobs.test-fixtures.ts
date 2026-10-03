import type { Effect } from "./effects";
import { createPlannerJobs, interruptPlannerJobs } from "./planner-jobs";
import type { Job, JobOutcome } from "./jobs";

export const AT = "2026-09-25T10:00:00.000Z";

export function harness(
	runner: (job: Job, prompt: string, signal?: AbortSignal) => Promise<JobOutcome>,
	options: {
		failPersist?: (attempt: number) => boolean;
		waitPersist?: (attempt: number) => Promise<void>;
		headingAllowed?: () => boolean;
		onCapacityAvailable?: () => void;
		exclusive?: <T>(action: () => Promise<T>) => Promise<T>;
	} = {},
) {
	let commits: Array<{ jobs: Job[]; lines: string[]; pending: Effect[]; receipts: string[] }> = [];
	let published: string[][] = [];
	let publishedAfter: number[] = [];
	let meta: string[] = [];
	let lines: string[] = [];
	let errors: unknown[] = [];
	let persistAttempts = 0;
	let plan = {
		conversationPlanJobs: [] as Job[],
		conversationPlanPendingEffects: [] as Effect[],
		conversationPlanEffects: [] as string[],
		records: new Map([["W1", {
			status: "open",
			definition: { questions: [{ question: "What auth system should we use?", options: [] }] },
		}]]),
		chat: { entries: [] },
		conversationPlan: { threads: [] as unknown[], events: [] as unknown[] },
	};
	let persist = async () => {
		persistAttempts++;
		await options.waitPersist?.(persistAttempts);
		if (options.failPersist?.(persistAttempts)) {
			throw new Error(`storage failure ${persistAttempts}`);
		}
		commits.push({
			jobs: structuredClone(plan.conversationPlanJobs),
			lines: [...lines],
			pending: structuredClone(plan.conversationPlanPendingEffects),
			receipts: [...plan.conversationPlanEffects],
		});
	};
	let service = createPlannerJobs({
		plan: plan as never,
		exclusive: options.exclusive ?? (async action => action()),
		persist,
		runner,
		prompt: () => "prompt",
		publishJobs: jobs => {
			published.push(jobs.map(job => `${job.id}:${job.status}`));
			publishedAfter.push(commits.length);
		},
		publishMeta: id => meta.push(id),
		activity: async text => {
			lines.push(text);
			try {
				await persist();
			} catch (error) {
				lines.pop();
				throw error;
			}
		},
		onError: error => errors.push(error),
		headingAllowed: options.headingAllowed,
		onCapacityAvailable: options.onCapacityAvailable,
		now: () => AT,
	});
	return { plan, service, persist, commits, published, publishedAfter, meta, lines, errors };
}

export function interrupt(h: ReturnType<typeof harness>): Promise<boolean> {
	return interruptPlannerJobs({
		plan: h.plan as never,
		exclusive: async action => action(),
		persist: h.persist,
		publishJobs: jobs => {
			h.published.push(jobs.map(job => `${job.id}:${job.status}`));
			h.publishedAfter.push(h.commits.length);
		},
		publishMeta: id => h.meta.push(id),
		onError: error => h.errors.push(error),
	});
}
