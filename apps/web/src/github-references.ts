import { gitHubReferenceKey, MAX_GITHUB_REFERENCES } from "@chopin/protocol/github-reference";

import { ApiError, response } from "./api";

import type { GitHubReferenceEntry, GitHubReferenceStore } from "@chopin/editor";
import type {
	GitHubReference,
	GitHubReferenceResult,
	GitHubReferencesResponse,
} from "@chopin/protocol/github-reference";

/** Links that appear together, as a document opens, are asked for together. */
export const BATCH_DELAY = 50;
/** An answer older than this is still shown, and asked for again. */
export const FRESH_FOR = 60_000;

export type GitHubReferenceFetch = (
	channelId: string,
	keys: readonly string[],
) => Promise<GitHubReferencesResponse>;

export function fetchGitHubReferences(
	channelId: string,
	keys: readonly string[],
): Promise<GitHubReferencesResponse> {
	let query = new URLSearchParams(keys.map(key => ["ref", key]));
	return response(`/api/channels/${encodeURIComponent(channelId)}/github-references?${query}`);
}

type Cached = { result: GitHubReferenceResult; at: number };
type Waiting = {
	promise: Promise<GitHubReferenceResult>;
	resolve: (value: GitHubReferenceResult) => void;
};

/*
 * Summaries belong to the signed-in person, not to a document, so every
 * document's store shares them. They live only in this page's memory, which
 * sign-out discards by reloading; an expired session clears them too.
 */
let shared = new Map<string, Cached>();
let generation = 0;
let stores = new Set<GitHubReferenceCache>();

export function clearGitHubReferences(): void {
	shared.clear();
	generation++;
	for (let store of stores) store.changed();
}

/** Neither access nor its absence: the pill stays neutral and claims nothing. */
const UNANSWERED: GitHubReferenceResult = { status: "rate-limited" };

export type GitHubReferenceCacheOptions = {
	channelId: string;
	fetch?: GitHubReferenceFetch;
	now?: () => number;
	schedule?: (callback: () => void, delay: number) => void;
};

/** The browser's GitHub reference summaries for one document's links. */
export class GitHubReferenceCache implements GitHubReferenceStore {
	#channelId: string;
	#fetch: GitHubReferenceFetch;
	#now: () => number;
	#schedule: (callback: () => void, delay: number) => void;
	#listeners = new Set<() => void>();
	#queued = new Map<string, Waiting>();
	#inflight = new Map<string, Promise<GitHubReferenceResult>>();
	#flushing = false;

	constructor(options: GitHubReferenceCacheOptions) {
		this.#channelId = options.channelId;
		this.#fetch = options.fetch ?? fetchGitHubReferences;
		this.#now = options.now ?? Date.now;
		this.#schedule = options.schedule ?? ((callback, delay) => void setTimeout(callback, delay));
	}

	/** Every subscribed store hears of a new answer, since they share them. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		stores.add(this);
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) stores.delete(this);
		};
	}

	changed(): void {
		for (let listener of this.#listeners) listener();
	}

	get(reference: GitHubReference): GitHubReferenceEntry {
		let key = gitHubReferenceKey(reference);
		let cached = shared.get(key);
		if (!cached || this.#stale(cached)) void this.#request(key);
		return cached?.result ?? { status: "loading" };
	}

	load(reference: GitHubReference): Promise<GitHubReferenceResult> {
		let key = gitHubReferenceKey(reference);
		let cached = shared.get(key);
		if (cached && !this.#stale(cached)) return Promise.resolve(cached.result);
		return this.#request(key);
	}

	#stale(cached: Cached): boolean {
		return this.#now() - cached.at > FRESH_FOR;
	}

	#request(key: string): Promise<GitHubReferenceResult> {
		let running = this.#inflight.get(key) ?? this.#queued.get(key)?.promise;
		if (running) return running;
		let resolve!: (value: GitHubReferenceResult) => void;
		let promise = new Promise<GitHubReferenceResult>(done => (resolve = done));
		this.#queued.set(key, { promise, resolve });
		if (!this.#flushing) {
			this.#flushing = true;
			this.#schedule(() => this.#flush(), BATCH_DELAY);
		}
		return promise;
	}

	#flush(): void {
		this.#flushing = false;
		let batch = [...this.#queued];
		this.#queued.clear();
		for (let start = 0; start < batch.length; start += MAX_GITHUB_REFERENCES) {
			void this.#send(batch.slice(start, start + MAX_GITHUB_REFERENCES));
		}
	}

	async #send(batch: [string, Waiting][]): Promise<void> {
		let keys = batch.map(([key]) => key);
		for (let [key, waiting] of batch) this.#inflight.set(key, waiting.promise);
		let started = generation;
		let references: GitHubReferencesResponse["references"] | undefined;
		try {
			references = (await this.#fetch(this.#channelId, keys)).references;
		} catch (error) {
			// A failed request says nothing about access. What was known stays,
			// counted fresh so a broken route is not retried on every keystroke.
			// A lapsed session is the exception: nothing it read should outlive it.
			if (error instanceof ApiError && error.status === 401) clearGitHubReferences();
		}
		let at = this.#now();
		for (let [key, waiting] of batch) {
			let result = references?.[key] ?? shared.get(key)?.result ?? UNANSWERED;
			this.#inflight.delete(key);
			if (started === generation) shared.set(key, { result, at });
			waiting.resolve(result);
		}
		if (started === generation) {
			for (let store of stores) store.changed();
		}
	}
}
