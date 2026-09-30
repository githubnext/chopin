/** Runs one document's durable Planner jobs in order. */

import * as Jobs from "./jobs";
import { type JobIntent, MAX_EFFECTS } from "./effects";
import type { Job, JobOutcome } from "./jobs";
import type { PlannerJobDeps } from "./planner-job-types";
import { canonicalIntent, currentProse, line, outcome, reason } from "./planner-job-support";

export { interruptPlannerJobs } from "./planner-job-interruption";
export { line } from "./planner-job-support";
export type { PlannerJobDeps, PlannerJobRunner } from "./planner-job-types";

export function createPlannerJobs(deps: PlannerJobDeps) {
	let { plan } = deps;
	let now = deps.now ?? (() => new Date().toISOString());
	let stopped = false;
	let controller = new AbortController();
	let draining: Promise<void> | undefined;
	let wakeRequested = false;

	function report(error: unknown): void {
		try {
			if (deps.onError) deps.onError(error);
			else console.error("[conversation-plan] Planner job failed:", error);
		} catch (reportError) {
			console.error("[conversation-plan] Planner job error reporting failed:", reportError);
		}
	}

	async function change(
		next: (jobs: Job[]) => Job[],
		commit: () => Promise<void> = deps.persist,
	): Promise<Job[] | undefined> {
		return deps.exclusive(async () => {
			if (stopped) return undefined;
			let previous = plan.conversationPlanJobs;
			let updated = next(previous);
			if (updated === previous) return undefined;
			plan.conversationPlanJobs = updated;
			try {
				await commit();
			} catch (error) {
				plan.conversationPlanJobs = previous;
				throw error;
			}
			return updated;
		});
	}

	async function enqueueWithReceipt(intent: JobIntent, key: string): Promise<Job | undefined> {
		return deps.exclusive(async () => {
			let receipts = plan.conversationPlanEffects;
			if (receipts.includes(key)) return undefined;
			if (stopped) throw new Error("Planner job service is stopped");
			let pending = plan.conversationPlanPendingEffects;
			let effect = pending.find(item => item.key === key);
			if (
				effect?.kind !== "job" || effect.intent.kind !== intent.kind
				|| effect.intent.target !== intent.target
				|| effect.intent.trigger !== intent.trigger
			) throw new Error("Planner job receipt has no matching pending job effect");

			let previous = plan.conversationPlanJobs;
			let canonical = canonicalIntent(plan, intent);
			let updated = intent.kind === "heading"
					&& (previous.some(job => job.kind === "heading") || deps.headingAllowed?.() === false)
				? previous
				: Jobs.enqueue(previous, canonical, now());
			plan.conversationPlanJobs = updated;
			plan.conversationPlanPendingEffects = pending.filter(item => item.key !== key);
			plan.conversationPlanEffects = [...receipts, key].slice(-MAX_EFFECTS);
			try {
				await deps.persist();
			} catch (error) {
				plan.conversationPlanJobs = previous;
				plan.conversationPlanPendingEffects = pending;
				plan.conversationPlanEffects = receipts;
				throw error;
			}
			return updated === previous
				? undefined
				: updated.find(job => job.id === Jobs.jobId(canonical));
		});
	}

	function announce(job: Job | undefined): void {
		if (stopped) return;
		try {
			deps.publishJobs(plan.conversationPlanJobs);
		} catch (error) {
			report(error);
		}
		if (job && job.target !== "document") {
			try {
				deps.publishMeta(job.target);
			} catch (error) {
				report(error);
			}
		}
	}

	async function run(job: Job): Promise<JobOutcome> {
		if (job.kind === "heading" && deps.headingAllowed?.() === false) {
			return { status: "skipped", reason: "The document already has prose." };
		}
		if (job.kind === "refine" || job.kind === "suggest") {
			let status = plan.records.get(job.target)?.status;
			if (status !== "open" && status !== "reopened") {
				return { status: "skipped", reason: "The decision card is no longer open." };
			}
		}
		if (job.kind === "prose") {
			if (!currentProse(plan, job)) {
				return { status: "skipped", reason: "The saved decision has changed." };
			}
		}
		try {
			let prompt = deps.prompt(job);
			if (prompt === undefined) {
				return { status: "failed", reason: `no prompt for ${job.kind} jobs` };
			}
			let result = outcome(await deps.runner(job, prompt, controller.signal));
			return job.kind === "prose" && !currentProse(plan, job)
				? { status: "skipped", reason: "The saved decision has changed." }
				: result;
		} catch (error) {
			return { status: "failed", reason: reason(error, "The Planner could not be reached.") };
		}
	}

	async function drain(): Promise<void> {
		for (;;) {
			if (stopped) return;
			let pending = Jobs.next(plan.conversationPlanJobs);
			if (!pending) return;
			let started = await change(jobs => Jobs.start(jobs, pending.id, now()));
			if (stopped) return;
			if (!started) continue;
			let running = started.find(job => job.id === pending.id);
			if (!running) throw new Error("started Planner job is missing");
			announce(running);
			let result = await run(running);
			if (stopped) return;
			let finalResult = result;
			let activity = result.status === "done" ? line(plan, running, result.output) : undefined;
			let settled = await change(
				jobs => {
					if (running.kind === "prose" && !currentProse(plan, running)) {
						finalResult = { status: "skipped", reason: "The saved decision has changed." };
						activity = undefined;
					}
					return Jobs.settle(jobs, running.id, finalResult, now());
				},
				() =>
					activity
						? deps.activity(activity[0], activity[1], activity[2])
						: deps.persist(),
			);
			if (!settled) continue;
			announce(settled.find(job => job.id === running.id));
			if (!stopped && finalResult.status === "done") {
				try {
					deps.onCapacityAvailable?.();
				} catch (error) {
					report(error);
				}
			}
		}
	}

	function wake(): void {
		if (stopped) return;
		if (draining) {
			wakeRequested = true;
			return;
		}
		let failed = false;
		draining = drain().catch(error => {
			failed = true;
			report(error);
		}).finally(() => {
			draining = undefined;
			let requested = wakeRequested;
			wakeRequested = false;
			if (!failed && requested && !stopped && Jobs.next(plan.conversationPlanJobs)) wake();
		});
	}

	return {
		async enqueue(intent: JobIntent, effectKey?: string): Promise<void> {
			if (effectKey !== undefined) {
				let changed = await enqueueWithReceipt(intent, effectKey);
				if (changed) announce(changed);
				wake();
				return;
			}
			if (stopped) throw new Error("Planner job service is stopped");
			let changed = await change(jobs => {
				if (
					intent.kind === "heading"
					&& (jobs.some(job => job.kind === "heading") || deps.headingAllowed?.() === false)
				) return jobs;
				return Jobs.enqueue(jobs, intent, now());
			});
			if (stopped && !changed) throw new Error("Planner job service is stopped");
			if (changed) announce(changed.find(job => job.id === Jobs.jobId(intent)));
			wake();
		},
		async retry(jobId: string): Promise<boolean> {
			let changed = await change(jobs => Jobs.retry(jobs, jobId, now()));
			if (!changed) return false;
			announce(changed.find(job => job.id === jobId));
			wake();
			return true;
		},
		wake,
		async idle(): Promise<void> {
			let task = draining;
			while (task) {
				await task;
				task = draining;
			}
		},
		stop(): void {
			stopped = true;
			controller.abort();
			wakeRequested = false;
		},
		jobs: () => plan.conversationPlanJobs,
	};
}
