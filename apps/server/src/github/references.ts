import { GitHubError } from "./client";

import type {
	GitHubReference,
	GitHubReferenceResult,
	GitHubReferenceSummary,
} from "@chopin/protocol/github-reference";
import type { GitHubConditional, GitHubReferenceSource, InstalledRepository } from "./client";

type Options = {
	clock?: () => number;
	ttlMs?: number;
	capacity?: number;
	concurrency?: number;
};

type Cached = {
	summary: GitHubReferenceSummary;
	etag?: string;
	expiresAt: number;
};

type Fetched =
	| { status: "ok"; summary: GitHubReferenceSummary }
	| { status: "unavailable" }
	| { status: "rate-limited" }
	| { status: "unauthorized" };

type Flight = {
	token: string;
	result: Promise<Fetched>;
};

const UNAVAILABLE = { status: "unavailable" } as const;
const RATE_LIMITED = { status: "rate-limited" } as const;

function outcome(err: unknown): Fetched {
	if (!(err instanceof GitHubError)) return UNAVAILABLE;
	if (err.status === 401) return { status: "unauthorized" };
	if (err.status === 429) return RATE_LIMITED;
	return UNAVAILABLE;
}

/**
 * Resolves pull request and issue summaries for one signed-in user. Every reference is
 * authorized against that user's App installation before the shared cache is consulted.
 */
export class GitHubReferences {
	readonly #source: GitHubReferenceSource;
	readonly #clock: () => number;
	readonly #ttl: number;
	readonly #capacity: number;
	readonly #concurrency: number;
	readonly #cache = new Map<string, Cached>();
	readonly #flights = new Map<string, Flight>();
	readonly #waiting: Array<() => void> = [];
	#active = 0;

	constructor(source: GitHubReferenceSource, options: Options = {}) {
		this.#source = source;
		this.#clock = options.clock ?? Date.now;
		this.#ttl = options.ttlMs ?? 60_000;
		this.#capacity = options.capacity ?? 500;
		this.#concurrency = options.concurrency ?? 4;
	}

	/** Throws a 401 `GitHubError` when the user's own token is rejected. */
	async resolve(token: string, references: GitHubReference[]): Promise<GitHubReferenceResult[]> {
		let access = new Map<string, Promise<InstalledRepository | undefined | "rate-limited">>();
		let installed = (reference: GitHubReference) => {
			let key = `${reference.owner}/${reference.repository}`.toLowerCase();
			let pending = access.get(key);
			if (!pending) {
				pending = this.#source.installedRepository(token, reference.owner, reference.repository)
					.catch(err => {
						let result = outcome(err);
						if (result.status === "unauthorized") throw err;
						return result.status === "rate-limited" ? "rate-limited" as const : undefined;
					});
				access.set(key, pending);
			}
			return pending;
		};
		return Promise.all(references.map(async (reference): Promise<GitHubReferenceResult> => {
			let target = await installed(reference);
			if (target === "rate-limited") return RATE_LIMITED;
			if (
				!target
				|| !target.repository.permissions.pull
				|| target.installation.suspended
				|| !(reference.kind === "pull"
					? target.installation.permissions.pullRequests
					: target.installation.permissions.issues)
			) return UNAVAILABLE;
			let key = `${target.repository.id}:${reference.kind}:${reference.number}`;
			let result = await this.#summary(token, target.repository, reference, key);
			if (result.status === "unauthorized") {
				throw new GitHubError("GitHub authorization expired", 401);
			}
			return result;
		}));
	}

	async #summary(
		token: string,
		repository: InstalledRepository["repository"],
		reference: GitHubReference,
		key: string,
	): Promise<Fetched> {
		let cached = this.#cache.get(key);
		if (cached && cached.expiresAt > this.#clock()) {
			this.#touch(key, cached);
			return { status: "ok", summary: cached.summary };
		}
		let flight = this.#flights.get(key);
		if (flight) {
			let shared = await flight.result;
			// Another user's rejected token says nothing about this user's access.
			if (shared.status !== "unauthorized" || flight.token === token) return shared;
		}
		let result = this.#fetch(token, repository, reference, key);
		this.#flights.set(key, { token, result });
		try {
			return await result;
		} finally {
			if (this.#flights.get(key)?.result === result) this.#flights.delete(key);
		}
	}

	async #fetch(
		token: string,
		repository: InstalledRepository["repository"],
		reference: GitHubReference,
		key: string,
	): Promise<Fetched> {
		await this.#acquire();
		try {
			let previous = this.#cache.get(key);
			let condition = previous?.etag ? { ifNoneMatch: previous.etag } : {};
			let response: GitHubConditional<GitHubReferenceSummary>;
			try {
				response = reference.kind === "pull"
					? await this.#source.pullRequest(
						token,
						repository.owner,
						repository.name,
						reference.number,
						condition,
					)
					: await this.#source.issue(
						token,
						repository.owner,
						repository.name,
						reference.number,
						condition,
					);
			} catch (err) {
				let result = outcome(err);
				if (result.status === "unavailable") this.#cache.delete(key);
				return result;
			}
			let expiresAt = this.#clock() + this.#ttl;
			if ("notModified" in response) {
				if (!previous) return UNAVAILABLE;
				this.#touch(key, { ...previous, expiresAt, etag: response.etag ?? previous.etag });
				return { status: "ok", summary: previous.summary };
			}
			let { etag, ...summary } = response as GitHubReferenceSummary & { etag?: string };
			this.#touch(key, { summary, expiresAt, ...(etag ? { etag } : {}) });
			return { status: "ok", summary };
		} finally {
			this.#release();
		}
	}

	#touch(key: string, entry: Cached): void {
		this.#cache.delete(key);
		this.#cache.set(key, entry);
		while (this.#cache.size > this.#capacity) {
			this.#cache.delete(this.#cache.keys().next().value!);
		}
	}

	async #acquire(): Promise<void> {
		if (this.#active < this.#concurrency) {
			this.#active++;
			return;
		}
		await new Promise<void>(resolve => this.#waiting.push(resolve));
	}

	#release(): void {
		let next = this.#waiting.shift();
		if (next) next();
		else this.#active--;
	}
}
