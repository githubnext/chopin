import type { DocumentTarget } from "../plan/service";
import type { JobService, JobView } from "./service";

export type SummaryCoordinatorOptions = {
	service: JobService;
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	debounceMs?: number;
	after?: (delayMs: number, action: () => void) => () => void;
	error?: (err: unknown) => void;
	completed?: (job: JobView) => Promise<void>;
};

type Pending = {
	target: DocumentTarget;
	cancel: () => void;
};

/** Coalesces document commits while durable target generations remain authoritative. */
export class DocumentSummaryCoordinator {
	#options: SummaryCoordinatorOptions;
	#debounceMs: number;
	#pending = new Map<string, Pending>();
	#chains = new Map<string, Promise<void>>();
	#inflight = new Set<Promise<void>>();
	#suspended = new Set<string>();
	#closed = false;

	constructor(options: SummaryCoordinatorOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? 30_000;
		if (!Number.isSafeInteger(this.#debounceMs) || this.#debounceMs < 0) {
			throw new Error("Document description debounce must be a non-negative integer.");
		}
	}

	schedule(target: DocumentTarget): void {
		if (this.#closed || this.#suspended.has(target.channelId)) return;
		let previous = this.#pending.get(target.channelId);
		if (
			previous?.target.revision === target.revision
			&& previous.target.sourceHash === target.sourceHash
		) return;
		previous?.cancel();
		this.#arm(target);
	}

	#arm(target: DocumentTarget): void {
		let after = this.#options.after ?? ((delay, action) => {
			let timer = setTimeout(action, delay);
			return () => clearTimeout(timer);
		});
		let cancel = after(this.#debounceMs, () => {
			let pending = this.#pending.get(target.channelId);
			if (!pending || pending.target !== target) return;
			void this.enqueueNow(target).then(() => {
				if (this.#pending.get(target.channelId)?.target === target) {
					this.#pending.delete(target.channelId);
				}
			}, err => {
				this.#options.error?.(err);
				if (!this.#closed && this.#pending.get(target.channelId)?.target === target) {
					this.#arm(target);
				}
			});
		});
		this.#pending.set(target.channelId, { target, cancel });
	}

	async ensure(channelId: string): Promise<void> {
		if (this.#closed || this.#suspended.has(channelId)) return;
		let target = await this.#options.current(channelId);
		if (target) await this.enqueueNow(target);
	}

	async enqueueNow(target: DocumentTarget): Promise<void> {
		if (this.#closed || this.#suspended.has(target.channelId)) return;
		let previous = this.#chains.get(target.channelId) ?? Promise.resolve();
		let operation = previous.then(async () => {
			if (this.#suspended.has(target.channelId)) return;
			let current = await this.#options.current(target.channelId);
			if (!current) return;
			let result = await this.#options.service.enqueueScheduler({
				channelId: current.channelId,
				type: "document-summary",
				targetKey: "document",
				idempotencyKey: `description-v1:${current.revision}:${current.sourceHash}`,
				input: {
					revision: current.revision,
					sourceHash: current.sourceHash,
					generatorVersion: 1,
					output: "description",
				},
			});
			if (result.job.state === "completed") await this.#options.completed?.(result.job);
		});
		let settled = operation.catch(() => {});
		this.#chains.set(target.channelId, settled);
		this.#inflight.add(operation);
		try {
			await operation;
		} catch (err) {
			if (
				!this.#closed && !this.#suspended.has(target.channelId)
				&& !this.#pending.has(target.channelId)
			) this.#arm(target);
			throw err;
		} finally {
			this.#inflight.delete(operation);
			if (this.#chains.get(target.channelId) === settled) this.#chains.delete(target.channelId);
		}
	}

	/** Stop new description work and wait for scheduling already admitted for one document. */
	async suspend(channelId: string): Promise<void> {
		this.#suspended.add(channelId);
		let pending = this.#pending.get(channelId);
		pending?.cancel();
		this.#pending.delete(channelId);
		await this.#chains.get(channelId);
	}

	resume(channelId: string): void {
		this.#suspended.delete(channelId);
	}

	async flush(): Promise<void> {
		await Promise.allSettled(this.#inflight);
		let pending = [...this.#pending.values()];
		for (let item of pending) item.cancel();
		let outcomes = await Promise.allSettled(pending.map(async item => {
			await this.enqueueNow(item.target);
			if (this.#pending.get(item.target.channelId)?.target === item.target) {
				this.#pending.delete(item.target.channelId);
			}
		}));
		let final = await Promise.allSettled(this.#inflight);
		let errors = [...outcomes, ...final].filter(result => result.status === "rejected");
		if (errors.length > 0) {
			throw new AggregateError(
				errors.map(result => result.reason),
				"Document description flush failed.",
			);
		}
	}

	close(): void {
		this.#closed = true;
		this.#suspended.clear();
		for (let pending of this.#pending.values()) pending.cancel();
		this.#pending.clear();
	}
}
