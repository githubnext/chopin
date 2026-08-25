import type { Research } from "@chopin/protocol";
import type { ResearchOpener, ResearchStore } from "@chopin/editor";

import {
	cancelResearchRequest,
	createResearchRequest,
	researchRequest,
	retryResearchRequest,
} from "./api";

const POLL_INTERVAL = 2_000;

export type ResearchRequestApi = {
	create(
		channelId: string,
		question: string,
		requestId: string,
	): Promise<{ request: Research.RequestView; repeated: boolean }>;
	get(channelId: string, requestId: string, signal?: AbortSignal): Promise<Research.RequestView>;
	cancel(channelId: string, requestId: string): Promise<Research.RequestView>;
	retry(channelId: string, requestId: string): Promise<Research.RequestView>;
};

export type ResearchRequestSchedule = (callback: () => void, delay: number) => () => void;

export type ResearchRequestStoreOptions = {
	api?: ResearchRequestApi;
	channelId: string;
	onOpen: (child: Research.ReadyChild, opener: ResearchOpener) => void;
	onPublished?: (child: Research.ReadyChild) => void;
	schedule?: ResearchRequestSchedule;
};

let browserApi: ResearchRequestApi = {
	cancel: cancelResearchRequest,
	create: createResearchRequest,
	get: researchRequest,
	retry: retryResearchRequest,
};

let browserSchedule: ResearchRequestSchedule = (callback, delay) => {
	let timer = setTimeout(callback, delay);
	return () => clearTimeout(timer);
};

type Read = {
	controller: AbortController;
	generation: number;
};

type Acceptance = "mutation" | "observation" | "retry";

const TERMINAL_STAGES = new Set<Research.RequestStage>(["ready", "failed", "cancelled"]);

export class ResearchRequestStore implements ResearchStore {
	#api: ResearchRequestApi;
	#channelId: string;
	#cancelPoll?: () => void;
	#disposed = false;
	#generations = new Map<string, number>();
	#listeners = new Set<() => void>();
	#onOpen: (child: Research.ReadyChild, opener: ResearchOpener) => void;
	#onPublished: (child: Research.ReadyChild) => void;
	#openers = new Map<string, { current: HTMLElement | null }>();
	#published = new Set<string>();
	#reads = new Map<string, Read>();
	#references = new Map<string, number>();
	#schedule: ResearchRequestSchedule;
	#snapshots = new Map<string, Research.RequestView>();

	constructor(options: ResearchRequestStoreOptions) {
		this.#api = options.api ?? browserApi;
		this.#channelId = options.channelId;
		this.#onOpen = options.onOpen;
		this.#onPublished = options.onPublished ?? (() => {});
		this.#schedule = options.schedule ?? browserSchedule;
	}

	subscribe(listener: () => void): () => void {
		if (this.#disposed) return () => {};
		this.#listeners.add(listener);
		this.#schedulePolling();
		return () => {
			this.#listeners.delete(listener);
			this.#schedulePolling();
		};
	}

	retain(id: string): () => void {
		if (this.#disposed) return () => {};
		this.#references.set(id, (this.#references.get(id) ?? 0) + 1);
		void this.#load(id);
		let retained = true;
		return () => {
			if (!retained) return;
			retained = false;
			let remaining = (this.#references.get(id) ?? 1) - 1;
			if (remaining > 0) {
				this.#references.set(id, remaining);
				return;
			}
			this.#references.delete(id);
			this.#snapshots.delete(id);
			this.#reads.get(id)?.controller.abort();
			this.#reads.delete(id);
			this.#schedulePolling();
		};
	}

	get(id: string): Research.RequestView | undefined {
		return this.#snapshots.get(id);
	}

	async create(question: string, requestId: string): Promise<Research.RequestView> {
		this.#assertAvailable();
		let result = await this.#api.create(this.#channelId, question, requestId);
		return this.#accept(result.request.id, result.request);
	}

	async cancel(id: string): Promise<Research.RequestView> {
		this.#assertAvailable();
		let result = await this.#api.cancel(this.#channelId, id);
		return this.#accept(id, result);
	}

	async retry(id: string): Promise<Research.RequestView> {
		this.#assertAvailable();
		let result = await this.#api.retry(this.#channelId, id);
		this.#fenceRead(id);
		return this.#accept(id, result, "retry");
	}

	open(child: Research.ReadyChild, opener: ResearchOpener): void {
		this.#onOpen(child, opener);
	}

	opener(id: string, current?: HTMLElement | null): ResearchOpener {
		let opener = this.#openers.get(id);
		if (!opener) {
			opener = { current: null };
			this.#openers.set(id, opener);
		}
		if (current !== undefined) opener.current = current;
		return opener;
	}

	invalidate(id: string): void {
		if (this.#disposed || !this.#references.has(id)) return;
		void this.#load(id, true);
	}

	/** Clears mounted observers and work while retaining the durable response cache. */
	reset(): void {
		if (this.#disposed) return;
		this.#stopPolling();
		for (let read of this.#reads.values()) read.controller.abort();
		this.#reads.clear();
		for (let opener of this.#openers.values()) opener.current = null;
		this.#openers.clear();
		this.#published.clear();
		this.#references.clear();
		this.#listeners.clear();
		this.#snapshots.clear();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.reset();
		this.#disposed = true;
	}

	#accept(
		id: string,
		snapshot: Research.RequestView,
		acceptance: Acceptance = "mutation",
	): Research.RequestView {
		if (snapshot.id !== id || snapshot.channelId !== this.#channelId) {
			throw new Error("Research request response did not match its document reference.");
		}
		if (this.#disposed) return snapshot;
		let previous = this.#snapshots.get(id);
		if (
			previous && TERMINAL_STAGES.has(previous.stage)
			&& (acceptance !== "retry" || previous.stage === "ready")
		) return previous;
		this.#snapshots.set(id, snapshot);
		if (
			previous && !previous.child && snapshot.stage === "ready" && snapshot.child
			&& !this.#published.has(id)
		) {
			this.#published.add(id);
			this.#onPublished(snapshot.child);
		}
		for (let listener of this.#listeners) listener();
		this.#schedulePolling();
		return snapshot;
	}

	async #load(id: string, replace = false): Promise<void> {
		let active = this.#reads.get(id);
		if (active && !replace) return;
		if (active) active.controller.abort();
		let controller = new AbortController();
		let generation = (this.#generations.get(id) ?? 0) + 1;
		this.#generations.set(id, generation);
		let read = { controller, generation };
		this.#reads.set(id, read);
		try {
			let snapshot = await this.#api.get(this.#channelId, id, controller.signal);
			let current = this.#reads.get(id);
			if (
				this.#disposed || controller.signal.aborted
				|| current !== read || current.generation !== generation
			) return;
			this.#accept(id, snapshot, "observation");
		} catch {
			// Refresh failures leave the last durable snapshot visible. Polling or
			// the next socket invalidation can retry the observational read.
		} finally {
			if (this.#reads.get(id) === read) this.#reads.delete(id);
			this.#schedulePolling();
		}
	}

	#fenceRead(id: string): void {
		let active = this.#reads.get(id);
		if (!active) return;
		active.controller.abort();
		this.#reads.delete(id);
		this.#generations.set(id, active.generation + 1);
	}

	#schedulePolling(): void {
		this.#stopPolling();
		if (this.#listeners.size === 0) return;
		let pending = [...this.#references.keys()].filter(id => {
			let snapshot = this.#snapshots.get(id);
			return !snapshot || !["ready", "failed", "cancelled"].includes(snapshot.stage);
		});
		if (pending.length === 0) return;
		this.#cancelPoll = this.#schedule(() => {
			this.#cancelPoll = undefined;
			for (let id of pending) {
				if (this.#references.has(id)) void this.#load(id);
			}
		}, POLL_INTERVAL);
	}

	#stopPolling(): void {
		this.#cancelPoll?.();
		this.#cancelPoll = undefined;
	}

	#assertAvailable(): void {
		if (this.#disposed) throw new Error("Research request store is disposed.");
	}
}
