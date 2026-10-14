import { parseRecommendationArtifact, parseRecommendationInput } from "./schema";

import type { RecommendationSnapshot } from "@chopin/protocol/recommendation";
import type { JobService, JobView } from "../jobs/service";
import type { BackgroundJobStore } from "../storage/port";
import type { RecommendationInput } from "./schema";

const TYPE = "build-recommendation";
const TARGET = `${TYPE}:document`;

type Options = {
	service: Pick<JobService, "enqueueScheduler">;
	jobs: Pick<BackgroundJobStore, "current">;
	current: (id: string) => Promise<RecommendationInput | undefined>;
	/** Existing ownership and capability only; never establishes a Planner owner. */
	eligible: (id: string) => Promise<boolean>;
	changed: (id: string) => void;
	error?: (error: unknown) => void;
	debounceMs?: number;
	after?: (delay: number, action: () => void) => () => void;
};

/** Durable jobs own results; this bounded coordinator only coalesces scheduling. */
export class RecommendationCoordinator {
	#options: Options;
	#keys = new Map<string, string>();
	#pending = new Map<string, () => void>();
	#chains = new Map<string, Promise<void>>();
	#epochs = new Map<string, object>();
	#reads = new Map<string, Set<{ stale: boolean }>>();
	#closed = false;

	constructor(options: Options) {
		this.#options = options;
	}

	#queue(id: string, action: (current: () => boolean) => Promise<void>): void {
		if (this.#closed) return;
		let epoch = this.#epochs.get(id) ?? {};
		this.#epochs.set(id, epoch);
		let current = () => !this.#closed && this.#epochs.get(id) === epoch;
		let next = (this.#chains.get(id) ?? Promise.resolve()).then(() => {
			if (current()) return action(current);
		}).catch(error => {
			this.#options.error?.(error);
		});
		this.#chains.set(id, next);
		void next.finally(() => {
			if (this.#chains.get(id) === next) this.#chains.delete(id);
		});
	}

	/** Called only after a context mutation has committed. Draft-only changes keep the key. */
	schedule(id: string): void {
		this.#queue(id, async current => {
			let input = await this.#options.current(id);
			if (!current()) return;
			let previous = this.#keys.get(id);
			if (!input) {
				this.forget(id);
				if (previous) this.#options.changed(id);
				return;
			}
			if (previous === input.key && this.#pending.has(id)) return;
			this.#keys.delete(id);
			this.#keys.set(id, input.key);
			if (previous !== input.key) {
				this.#invalidate(id);
				this.#options.changed(id);
			}
			this.#pending.get(id)?.();
			let after = this.#options.after ?? ((delay, action) => {
				let timer = setTimeout(action, delay);
				return () => clearTimeout(timer);
			});
			let cancel = after(this.#options.debounceMs ?? 10_000, () => {
				if (this.#pending.get(id) !== cancel) return;
				this.#pending.delete(id);
				this.#queue(id, current => this.#enqueue(id, current));
			});
			this.#pending.set(id, cancel);
			for (let oldest of this.#keys.keys()) {
				if (this.#keys.size <= 500) break;
				this.forget(oldest);
			}
		});
	}

	async #enqueue(id: string, active: () => boolean): Promise<void> {
		if (!active() || !await this.#options.eligible(id)) return;
		let input = await this.#options.current(id);
		if (!input || !active()) return;
		let current = await this.#options.jobs.current(id, TARGET);
		if (
			current && current.job.targetGeneration === current.target.generation
			&& parseRecommendationInput(current.job.input).key === input.key
		) return;
		if (!active()) return;
		await this.#options.service.enqueueScheduler({
			channelId: id,
			type: TYPE,
			targetKey: "document",
			idempotencyKey: `advice:${input.key}:${(current?.target.generation ?? 0) + 1}`,
			input,
		});
	}

	/** Reads never restart terminal work or claim ownership, including after a process restart. */
	async read(id: string): Promise<RecommendationSnapshot> {
		let reads = this.#reads.get(id) ?? new Set<{ stale: boolean }>();
		this.#reads.set(id, reads);
		let reading = { stale: false };
		reads.add(reading);
		try {
			return await this.#read(id, () => !reading.stale && !this.#closed);
		} finally {
			reads.delete(reading);
			if (!reads.size) this.#reads.delete(id);
		}
	}

	async #read(id: string, current: () => boolean): Promise<RecommendationSnapshot> {
		let input = await this.#options.current(id);
		if (!input || this.#closed) return { state: "unavailable" };
		let detail = await this.#options.jobs.current(id, TARGET);
		let fresh = await this.#options.current(id);
		if (!fresh) return { state: "unavailable" };
		if (!current() || fresh.key !== input.key) return { state: "pending", key: fresh.key };
		if (
			!detail || detail.job.targetGeneration !== detail.target.generation
			|| parseRecommendationInput(detail.job.input).key !== input.key
		) {
			return await this.#options.eligible(id)
				? { state: "pending", key: input.key }
				: { state: "unavailable" };
		}
		if (detail.job.state === "completed" && detail.artifact) {
			let artifact = parseRecommendationArtifact(detail.artifact.value, input);
			if (!artifact.recommendation) return { state: "quiet", key: input.key };
			let recommendation = artifact.recommendation;
			return {
				state: "ready",
				key: input.key,
				planRevision: input.planRevision,
				recommendation,
				evidence: input.evidence.filter(item => recommendation.evidenceIds.includes(item.id)),
			};
		}
		return {
			state: ["failed", "cancelled", "superseded"].includes(detail.job.state)
				? "failed"
				: "pending",
			key: input.key,
		};
	}

	jobChanged(job: JobView): void {
		if (!this.#closed && job.type === TYPE) {
			this.#invalidate(job.channelId);
			this.#options.changed(job.channelId);
		}
	}

	#invalidate(id: string): void {
		for (let reading of this.#reads.get(id) ?? []) reading.stale = true;
	}

	forget(id: string): void {
		this.#invalidate(id);
		this.#epochs.delete(id);
		this.#pending.get(id)?.();
		this.#pending.delete(id);
		this.#keys.delete(id);
	}

	async idle(): Promise<void> {
		while (this.#chains.size) await Promise.all(this.#chains.values());
	}

	close(): void {
		this.#closed = true;
		for (let cancel of this.#pending.values()) cancel();
		this.#pending.clear();
		this.#keys.clear();
		this.#epochs.clear();
	}
}
