/** Pure transitions for the durable Planner job queue. */

import type { ConversationPlan } from "@chopin/protocol";
import type { JobIntent } from "./effects";

export type Job = ConversationPlan.Job;
export type JobOutcome =
	| { status: "done"; output: string }
	| { status: "failed" | "skipped"; reason: string };

export const MAX_JOBS = 128;
const MAX_TARGET = 200;
const MAX_TRIGGER = 200;
const MAX_REASON = 500;
const MAX_OUTPUT = 4096;
const KINDS = new Set(["heading", "refine", "suggest", "prose"]);
const STATUSES = new Set(["pending", "running", "done", "failed", "skipped"]);

function invalid(): never {
	throw new Error("invalid Planner job in sidecar");
}

function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= max;
}

function isoTime(value: unknown): value is string {
	return typeof value === "string"
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
		&& Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString() === value;
}

function jsonOutput(value: unknown): value is string {
	if (!bounded(value, MAX_OUTPUT)) return false;
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

export function jobId(intent: JobIntent): string {
	if (intent.target.includes(":")) invalid();
	return `${intent.kind}:${intent.target}:${intent.trigger}`;
}

export function enqueue(jobs: Job[], intent: JobIntent, at: string): Job[] {
	if (
		!KINDS.has(intent.kind) || !bounded(intent.target, MAX_TARGET)
		|| !bounded(intent.trigger, MAX_TRIGGER)
		|| (intent.kind === "heading") !== (intent.target === "document")
		|| !isoTime(at)
	) invalid();
	let id = jobId(intent);
	if (jobs.some(job => job.id === id)) return jobs;
	if (intent.kind === "refine" || intent.kind === "suggest") {
		let pending = jobs.findIndex(job =>
			(job.kind === "refine" || job.kind === "suggest")
			&& job.target === intent.target && job.status === "pending"
		);
		if (pending >= 0) {
			if (intent.kind === "suggest" || jobs[pending]!.kind === "refine") return jobs;
			return jobs.map((job, index) =>
				index === pending ? { ...job, id, kind: "refine", trigger: intent.trigger, at } : job
			);
		}
	}
	let available = jobs;
	if (jobs.length >= MAX_JOBS) {
		let oldestTerminal = jobs.findIndex(job => job.status === "done" || job.status === "skipped");
		if (oldestTerminal < 0) throw new Error("Planner job queue is full");
		available = jobs.filter((_, index) => index !== oldestTerminal);
	}
	return [...available, { id, ...intent, status: "pending", attempts: 0, at }];
}

export function next(jobs: Job[]): Job | undefined {
	if (jobs.some(job => job.status === "running")) return;
	return jobs.find(job => job.status === "pending");
}

export function start(jobs: Job[], id: string, at: string): Job[] {
	if (next(jobs)?.id !== id) return jobs;
	if (!isoTime(at)) invalid();
	return jobs.map(job => job.id === id ? { ...job, status: "running", at } : job);
}

export function settle(jobs: Job[], id: string, outcome: JobOutcome, at: string): Job[] {
	let running = jobs.find(job => job.id === id && job.status === "running");
	if (!running) return jobs;
	if (
		!isoTime(at) || running.attempts >= Number.MAX_SAFE_INTEGER
		|| (outcome.status === "done"
			? !jsonOutput(outcome.output)
			: !["failed", "skipped"].includes(outcome.status)
				|| !bounded(outcome.reason, MAX_REASON))
	) invalid();
	return jobs.map(job => {
		if (job.id !== id) return job;
		let { reason: _reason, output: _output, ...rest } = job;
		return outcome.status === "done"
			? { ...rest, status: "done", attempts: job.attempts + 1, output: outcome.output, at }
			: { ...rest, status: outcome.status, attempts: job.attempts + 1, reason: outcome.reason, at };
	});
}

export function retry(jobs: Job[], id: string, at: string): Job[] {
	let failed = jobs.find(job => job.id === id && job.status === "failed");
	if (!failed) return jobs;
	if (
		(failed.kind === "refine" || failed.kind === "suggest")
		&& jobs.some(job =>
			job.status === "pending" && (job.kind === "refine" || job.kind === "suggest")
			&& job.target === failed.target
		)
	) return jobs;
	if (!isoTime(at)) invalid();
	return jobs.map(job => {
		if (job.id !== id) return job;
		let { reason: _reason, ...rest } = job;
		return { ...rest, status: "pending", at };
	});
}

export function refining(jobs: Job[], questionnaireId: string): boolean {
	return jobs.some(job =>
		job.kind === "refine" && job.target === questionnaireId
		&& (job.status === "pending" || job.status === "running")
	);
}

export function forTrigger(jobs: Job[], messageId: string): Job[] {
	return jobs.filter(job => job.trigger === messageId);
}

export function restore(value: unknown): Job[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_JOBS) invalid();
	let ids = new Set<string>();
	let pendingCards = new Set<string>();
	let running = 0;
	for (let raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
		let job = raw as Record<string, unknown>;
		let required = ["id", "kind", "target", "trigger", "status", "attempts", "at"];
		if (
			required.some(key => !Object.hasOwn(job, key))
			|| Object.keys(job).some(key => ![...required, "reason", "output"].includes(key))
			|| !KINDS.has(job.kind as string)
			|| !STATUSES.has(job.status as string)
			|| !bounded(job.target, MAX_TARGET)
			|| (job.target as string).includes(":")
			|| !bounded(job.trigger, MAX_TRIGGER)
			|| !bounded(job.id, 420)
			|| job.id !== `${job.kind}:${job.target}:${job.trigger}`
			|| ids.has(job.id)
			|| !Number.isSafeInteger(job.attempts) || (job.attempts as number) < 0
			|| !isoTime(job.at)
			|| (job.kind === "heading") !== (job.target === "document")
		) invalid();
		ids.add(job.id as string);
		let hasReason = Object.hasOwn(job, "reason");
		let hasOutput = Object.hasOwn(job, "output");
		if (job.status === "pending" || job.status === "running") {
			if (hasReason || hasOutput) invalid();
			if (job.status === "running" && ++running > 1) invalid();
			if (
				job.status === "pending" && (job.kind === "refine" || job.kind === "suggest")
			) {
				if (pendingCards.has(job.target as string)) invalid();
				pendingCards.add(job.target as string);
			}
		} else if (job.status === "done") {
			if (hasReason || !hasOutput || !jsonOutput(job.output) || job.attempts === 0) {
				invalid();
			}
		} else {
			if (
				hasOutput || !hasReason || !bounded(job.reason, MAX_REASON)
				|| job.attempts === 0 && (job.status !== "failed" || job.reason !== "interrupted")
			) invalid();
		}
	}
	return value.map((job: Job) =>
		job.status === "running" ? { ...job, status: "failed", reason: "interrupted" } : job
	);
}
