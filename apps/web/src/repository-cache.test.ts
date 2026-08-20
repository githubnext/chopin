import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	clearRepositoryCache,
	installedRepositoryGroups,
	loadRepositorySnapshot,
	readRepositoryCache,
	repositoryCacheIsStale,
	writeRepositoryCache,
} from "./repository-cache";

import type { RepositorySnapshot } from "./repository-cache";

class MemoryStorage implements Storage {
	readonly #values = new Map<string, string>();

	get length(): number {
		return this.#values.size;
	}

	clear(): void {
		this.#values.clear();
	}

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalFetch = globalThis.fetch;

function snapshot(userId = "U_octocat"): RepositorySnapshot {
	let installation = {
		id: "101",
		account: { login: "octo-org", avatarUrl: "avatar", type: "organization" as const },
		repositorySelection: "selected" as const,
		configureUrl: "https://github.test/settings/installations/101",
		suspended: false,
		permissions: { contents: true, pullRequests: true, checks: true, statuses: true },
	};
	let score = {
		id: "R_score",
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};
	return {
		version: 1,
		userId,
		validatedAt: 10_000,
		installationPages: [{
			page: 1,
			etag: '"installations"',
			value: { installations: [installation] },
		}],
		repositoryPages: {
			"101": [{
				page: 1,
				etag: '"repositories-1"',
				value: { repositories: [score], nextPage: 2 },
			}, {
				page: 2,
				etag: '"repositories-2"',
				value: {
					repositories: [score, {
						...score,
						id: "R_archive",
						name: "archive",
						fullName: "octo-org/archive",
					}],
				},
			}],
		},
	};
}

beforeEach(() => {
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: new MemoryStorage(),
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
});

describe("the repository tab cache", () => {
	it("validates stored snapshots and removes the previous user's data", () => {
		let stored = snapshot();
		writeRepositoryCache(stored);
		expect(readRepositoryCache(stored.userId)).toEqual(stored);
		expect(installedRepositoryGroups(stored)[0]!.repositories.map(value => value.id)).toEqual([
			"R_score",
			"R_archive",
		]);

		expect(readRepositoryCache("U_other")).toBeUndefined();
		expect(sessionStorage.getItem("chopin:repositories:U_octocat")).toBeNull();
		sessionStorage.setItem("chopin:repositories:U_other", "not json");
		expect(readRepositoryCache("U_other")).toBeUndefined();
		expect(sessionStorage.getItem("chopin:repositories:U_other")).toBeNull();
	});

	it("clears the active user's snapshot and applies the freshness window", () => {
		let stored = snapshot();
		writeRepositoryCache(stored);
		expect(repositoryCacheIsStale(stored, stored.validatedAt + 29_999)).toBe(false);
		expect(repositoryCacheIsStale(stored, stored.validatedAt + 30_000)).toBe(true);
		clearRepositoryCache(stored.userId);
		expect(readRepositoryCache(stored.userId)).toBeUndefined();
	});

	it("rejects incomplete cached pagination chains", () => {
		let stored = snapshot();
		stored.repositoryPages["101"]!.pop();
		writeRepositoryCache(stored);
		expect(readRepositoryCache(stored.userId)).toBeUndefined();
	});

	it("revalidates every cached page with its own etag", async () => {
		let previous = snapshot();
		let requests: Array<{ path: string; etag: string | null }> = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				let path = String(input);
				let etag = new Headers(init?.headers).get("if-none-match");
				requests.push({ path, etag });
				return new Response(null, { status: 304, headers: etag ? { etag } : undefined });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		let refreshed = await loadRepositorySnapshot(previous.userId, previous);
		expect(installedRepositoryGroups(refreshed)).toEqual(installedRepositoryGroups(previous));
		expect(requests).toEqual([{
			path: "/api/github/installations?page=1",
			etag: '"installations"',
		}, {
			path: "/api/github/installations/101/repositories?page=1",
			etag: '"repositories-1"',
		}, {
			path: "/api/github/installations/101/repositories?page=2",
			etag: '"repositories-2"',
		}]);
		expect(refreshed.validatedAt).toBeGreaterThan(previous.validatedAt);
	});

	it("rebuilds pagination when a changed page shortens the chain", async () => {
		let previous = snapshot();
		let archive = installedRepositoryGroups(previous)[0]!.repositories[1]!;
		let requests: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request) => {
				let path = String(input);
				requests.push(path);
				if (path.includes("/repositories")) {
					return Response.json({ repositories: [archive] }, { headers: { etag: '"changed"' } });
				}
				return new Response(null, { status: 304, headers: { etag: '"installations"' } });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		let refreshed = await loadRepositorySnapshot(previous.userId, previous);
		expect(requests).toEqual([
			"/api/github/installations?page=1",
			"/api/github/installations/101/repositories?page=1",
		]);
		expect(installedRepositoryGroups(refreshed)[0]!.repositories).toEqual([archive]);
		expect(refreshed.repositoryPages["101"]).toHaveLength(1);
	});
});
