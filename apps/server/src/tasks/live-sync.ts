import { buildActive, queueRebuild } from "./builds";
import { readCurrentDocument } from "../plan/service";
import type { RebuildConnections } from "./builds";
import type { DocumentTarget, Plan } from "../plan/service";
import type { BuildRequest } from "@chopin/protocol/implementation";

/** Everything edited since the live build, always measured from its base source. */
export type LiveDelta = {
	channelId: string;
	baseRevision: number;
	targetRevision: number;
	baseSource: string;
	source: string;
	pullRequests: string[];
};

/** Decides whether a delta is worth rebuilding. A model-backed classifier replaces the default. */
export type LiveClassifier = { classify: (delta: LiveDelta) => Promise<boolean> };

export let sourcesDiffer: LiveClassifier = {
	classify: async delta => delta.source !== delta.baseSource,
};

export type LiveSyncOptions = {
	/** Run against the open document under its document lock. */
	withPlan: <T>(channelId: string, action: (plan: Plan) => Promise<T>) => Promise<T>;
	connections: RebuildConnections;
	classifier?: LiveClassifier;
	/** A rebuild was persisted; wake its connector. */
	queued?: (channelId: string, build: BuildRequest) => void;
	debounceMs?: number;
	after?: (delayMs: number, action: () => void) => () => void;
	error?: (err: unknown) => void;
};

/**
 * Rebuilds a living document once every editor has been quiet for the debounce window.
 *
 * A check that finds a build in flight waits for that build to stop, then checks again; edits
 * made meanwhile join the next delta because it always runs from the live base source.
 */
export class LiveSyncCoordinator {
	#options: LiveSyncOptions;
	#debounceMs: number;
	#pending = new Map<string, { cancel: () => void }>();
	#waiting = new Set<string>();
	#chains = new Map<string, Promise<void>>();
	#closed = false;

	constructor(options: LiveSyncOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? 45_000;
	}

	schedule(target: Pick<DocumentTarget, "channelId">): void {
		if (this.#closed) return;
		let id = target.channelId;
		this.#pending.get(id)?.cancel();
		let after = this.#options.after ?? ((delay, action) => {
			let timer = setTimeout(action, delay);
			return () => clearTimeout(timer);
		});
		let entry = { cancel: () => {} };
		entry.cancel = after(this.#debounceMs, () => {
			if (this.#pending.get(id) !== entry) return;
			this.#pending.delete(id);
			void this.check(id);
		});
		this.#pending.set(id, entry);
	}

	/** A build stopped; run a check deferred behind it unless newer edits are still settling. */
	stopped(channelId: string): void {
		if (!this.#waiting.delete(channelId) || this.#closed) return;
		if (!this.#pending.has(channelId)) void this.check(channelId);
	}

	/** Serialized per document so a deferred check and a timer cannot both queue. */
	check(channelId: string): Promise<void> {
		let previous = this.#chains.get(channelId) ?? Promise.resolve();
		let operation = previous.then(() => this.#check(channelId)).catch(err => {
			this.#options.error?.(err);
		});
		this.#chains.set(channelId, operation);
		void operation.then(() => {
			if (this.#chains.get(channelId) === operation) this.#chains.delete(channelId);
		});
		return operation;
	}

	async #check(channelId: string): Promise<void> {
		if (this.#closed) return;
		let delta = await this.#options.withPlan(channelId, async plan => {
			let live = plan.live;
			if (!plan.persistence.liveBuild || !live) return;
			let current = await readCurrentDocument(plan);
			if (current.source === live.baseSource) return;
			if (buildActive(plan)) {
				this.#waiting.add(channelId);
				return;
			}
			return {
				channelId,
				baseRevision: live.baseRevision,
				targetRevision: current.revision,
				baseSource: live.baseSource,
				source: current.source,
				pullRequests: [...live.pullRequests],
			};
		});
		if (!delta || this.#closed) return;
		let classifier = this.#options.classifier ?? sourcesDiffer;
		if (!await classifier.classify(delta)) return;
		let result = await this.#options.withPlan(
			channelId,
			plan => queueRebuild(plan, this.#options.connections),
		);
		if (result.kind === "busy") this.#waiting.add(channelId);
		if (result.kind === "queued") this.#options.queued?.(channelId, result.build);
	}

	close(): void {
		this.#closed = true;
		for (let pending of this.#pending.values()) pending.cancel();
		this.#pending.clear();
		this.#waiting.clear();
	}
}
