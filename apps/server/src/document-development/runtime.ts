import type { JobService, JobView } from "../jobs/service";
import type { Plan } from "../plan/service";
import * as Service from "../plan/service";
import {
	DocumentDevelopmentCapacityError,
	type DocumentDevelopmentInput,
	parseDocumentDevelopmentArtifact,
	parseDocumentDevelopmentOutput,
} from "./schema";
import { discard, fresh, link, QUIET_MS, reserve, save } from "./admission";
import { reconcile } from "./reconcile";
import { latest, ordinary } from "./snapshot";
import * as State from "./state";
import { StorageError } from "../storage/errors";
import type { Chat } from "@chopin/protocol";

export type Options = {
	jobs: Pick<JobService, "enqueueScheduler" | "get" | "pause" | "resume">;
	withPlan: <T>(
		id: string,
		action: (plan: Plan, available: () => boolean) => Promise<T>,
	) => Promise<T | undefined>;
	authorize: (id: string) => Promise<{ valid: () => boolean; release: () => void } | undefined>;
	changed?: (plan: Plan) => void;
	error: (error: unknown) => void;
	now?: () => number;
	after?: (ms: number, action: () => void) => () => void;
};

/** Timers coalesce human discussion; the sidecar outbox and jobs make delivery restart-safe. */
export class DocumentDevelopment {
	#options: Options;
	#pending = new Map<string, () => void>();
	#chains = new Map<string, Promise<void>>();
	#closed = false;

	constructor(options: Options) {
		this.#options = options;
	}

	message(plan: Plan, entry: Chat.Entry): void {
		if (!ordinary(entry) || plan.parentChannelId) return;
		this.#schedule(plan.id, QUIET_MS, true);
	}

	wake(plan: Plan): void {
		if (plan.parentChannelId) return;
		if (
			plan.documentDevelopment?.pending
			|| latest(plan)?.id !== plan.documentDevelopment?.lastMessageId
		) {
			this.#schedule(plan.id, QUIET_MS);
		}
	}

	jobChanged(job: JobView): void {
		if (job.type !== "document-development") return;
		if (
			["pending", "paused", "completed", "failed", "cancelled", "superseded"].includes(job.state)
		) {
			this.#schedule(job.channelId, 0, true);
		}
	}

	#schedule(id: string, ms: number, replace = false): void {
		if (this.#closed || this.#pending.has(id) && !replace) return;
		this.#pending.get(id)?.();
		let after = this.#options.after ?? ((delay, action) => {
			let timer = setTimeout(action, delay);
			return () => clearTimeout(timer);
		});
		let cancel = after(ms, () => {
			if (this.#pending.get(id) !== cancel) return;
			this.#pending.delete(id);
			void this.run(id).catch(this.#options.error);
		});
		this.#pending.set(id, cancel);
	}

	/** Exposed for deterministic coordination tests and explicit availability wakes. */
	async run(id: string): Promise<void> {
		if (this.#closed) return;
		await this.#coordinate(id, async () => {
			if (this.#closed) return;
			await this.#options.withPlan(id, async (plan, available) => {
				if (!available()) return;
				await this.#recover(plan);
				if (plan.documentDevelopment?.paused) {
					this.forget(id);
					return;
				}
				let before = plan.documentDevelopment;
				let admission = await reserve(plan, available, this.#options.now?.() ?? Date.now());
				if (!admission) {
					if (before !== plan.documentDevelopment) this.#options.changed?.(plan);
					return;
				}
				if ("wait" in admission) {
					this.#schedule(id, admission.wait);
					return;
				}
				let { input } = admission;
				let jobId = admission.jobId;
				if (!jobId) {
					if (!available() || Service.implementationActive(plan)) return;
					if (!fresh(plan, input)) {
						await discard(plan, input.messageId, "stale-before-enqueue");
						return;
					}
					jobId = await this.#enqueue(plan, input);
				}
				let detail = await this.#options.jobs.get(id, jobId);
				if (!detail || !available()) return;
				if (detail.job.state === "completed" && detail.artifact) {
					if (detail.target.generation !== detail.job.targetGeneration || !fresh(plan, input)) {
						await discard(plan, input.messageId, jobId);
					} else {
						let owner = await this.#options.authorize(id);
						if (!owner) return;
						let unavailable = false;
						try {
							let artifact = parseDocumentDevelopmentArtifact(detail.artifact.value);
							if (
								artifact.messageId !== input.messageId || artifact.revision !== input.revision
								|| artifact.decisionHash !== input.decisionHash
							) throw new Error("document development artifact identity mismatch");
							let output = parseDocumentDevelopmentOutput({
								changes: artifact.changes,
								removals: artifact.removals,
							}, input);
							let result = await reconcile(plan, {
								jobId,
								messageId: input.messageId,
								sourceIds: input.messages.map(message => message.id),
								passages: input.passages.filter(passage => passage.editable),
								...output,
							}, () => {
								if (
									!available() || !owner.valid() || plan.documentDevelopment?.paused
									|| Service.implementationActive(plan)
								) {
									unavailable = true;
									return false;
								}
								return fresh(plan, input);
							});
							if (result.status === "stale" && (!unavailable || !fresh(plan, input))) {
								await discard(plan, input.messageId, jobId);
							}
							if (result.status === "capacity") {
								await discard(plan, input.messageId, jobId, "failed");
							}
							if (result.status === "deferred") this.#schedule(id, QUIET_MS);
						} catch (error) {
							if (!(error instanceof DocumentDevelopmentCapacityError)) throw error;
							await discard(plan, input.messageId, jobId, "failed");
						} finally {
							owner.release();
						}
					}
				} else if (["failed", "cancelled", "superseded"].includes(detail.job.state)) {
					await discard(
						plan,
						input.messageId,
						jobId,
						detail.job.state === "failed" ? "failed" : "stale",
					);
				}
				this.#options.changed?.(plan);
				let message = latest(plan);
				if (message && ordinary(message) && message.id !== input.messageId) {
					this.#schedule(id, QUIET_MS);
				}
			});
		});
	}

	async #coordinate(id: string, action: () => Promise<void>): Promise<void> {
		let previous = this.#chains.get(id) ?? Promise.resolve();
		let operation = previous.then(action);
		let settled = operation.catch(() => {});
		this.#chains.set(id, settled);
		try {
			await operation;
		} finally {
			if (this.#chains.get(id) === settled) this.#chains.delete(id);
		}
	}

	async pause(plan: Plan, paused: boolean): Promise<void> {
		await this.#coordinate(plan.id, async () => {
			await Service.exclusive(plan, async () => {
				let state = State.capture(plan) ?? State.initial();
				await save(plan, { ...state, paused });
			});
			this.#options.changed?.(plan);
			if (paused) this.forget(plan.id);
			try {
				await this.#recover(plan);
			} catch (error) {
				this.#schedule(plan.id, QUIET_MS);
				throw error;
			}
			if (!paused) this.wake(plan);
		});
	}

	async #enqueue(plan: Plan, input: DocumentDevelopmentInput): Promise<string> {
		let queued = await this.#options.jobs.enqueueScheduler({
			channelId: plan.id,
			type: "document-development",
			targetKey: "document",
			idempotencyKey: `document-development:${Service.sourceHash(JSON.stringify(input))}`,
			input,
		});
		await link(plan, input, queued.job.id);
		this.#options.changed?.(plan);
		return queued.job.id;
	}

	async #recover(plan: Plan): Promise<void> {
		let pending = plan.documentDevelopment?.pending;
		if (!pending) return;
		if (!fresh(plan, pending.input)) {
			await discard(plan, pending.input.messageId, pending.jobId ?? "stale-before-enqueue");
			this.#options.changed?.(plan);
			return;
		}
		let jobId = pending.jobId ?? await this.#enqueue(plan, pending.input);
		if (!plan.documentDevelopment?.paused && Service.implementationActive(plan)) return;
		for (let attempt = 0; attempt < 3; attempt++) {
			let detail = await this.#options.jobs.get(plan.id, jobId);
			if (!detail || detail.target.generation !== detail.job.targetGeneration) return;
			let request = { channelId: plan.id, jobId, expectedRevision: detail.job.revision };
			try {
				if (plan.documentDevelopment?.paused && ["pending", "running"].includes(detail.job.state)) {
					await this.#options.jobs.pause(request, "document-paused");
				} else if (!plan.documentDevelopment?.paused && detail.job.state === "paused") {
					if (detail.job.reason === "document-paused") await this.#options.jobs.resume(request);
					else if (detail.job.reason === "owner-unavailable") {
						let owner = await this.#options.authorize(plan.id);
						if (!owner) return;
						try {
							if (owner.valid()) await this.#options.jobs.resume(request);
						} finally {
							owner.release();
						}
					}
				}
				return;
			} catch (error) {
				if (!(error instanceof StorageError) || error.failure !== "conflict") throw error;
			}
		}
		this.#schedule(plan.id, QUIET_MS);
	}

	forget(id: string): void {
		this.#pending.get(id)?.();
		this.#pending.delete(id);
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (let cancel of this.#pending.values()) cancel();
		this.#pending.clear();
		await Promise.allSettled(this.#chains.values());
	}
}
