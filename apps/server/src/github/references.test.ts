import { describe, expect, it } from "bun:test";

import { GitHubError } from "./client";
import { GitHubReferences } from "./references";

import type {
	GitHubIssueSummary,
	GitHubPullRequestSummary,
	GitHubReference,
} from "@chopin/protocol/github-reference";
import type {
	GitHubCondition,
	GitHubConditional,
	GitHubInstallation,
	GitHubReferenceSource,
	InstalledRepository,
} from "./client";

function installation(overrides: Partial<GitHubInstallation["permissions"]> = {}) {
	return {
		id: "101",
		account: { login: "octo-org", avatarUrl: "", type: "organization" },
		repositorySelection: "selected",
		configureUrl: "",
		suspended: false,
		permissions: {
			contents: true,
			pullRequests: true,
			checks: true,
			statuses: true,
			issues: true,
			...overrides,
		},
	} satisfies GitHubInstallation;
}

function installed(name: string, id = `R_${name}`): InstalledRepository {
	return {
		repository: {
			id,
			owner: "octo-org",
			name,
			fullName: `octo-org/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions: { pull: true, push: false, admin: false },
		},
		installation: installation(),
	};
}

function pullSummary(number: number): GitHubPullRequestSummary {
	return {
		kind: "pull",
		owner: "octo-org",
		repository: "score",
		number,
		url: `https://github.com/octo-org/score/pull/${number}`,
		title: `Pull ${number}`,
		author: null,
		labels: [],
		comments: 0,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		closedAt: null,
		state: "open",
		draft: false,
		mergedAt: null,
		headBranch: "topic",
		baseBranch: "main",
	};
}

function ref(number: number, kind: "pull" | "issue" = "pull", repository = "score") {
	return { owner: "octo-org", repository, kind, number } satisfies GitHubReference;
}

class FakeSource implements GitHubReferenceSource {
	/** Repositories visible to each token through its App installation. */
	access = new Map<string, Map<string, InstalledRepository>>();
	calls: Array<{ token: string; number: number; condition?: GitHubCondition }> = [];
	fail?: GitHubError;
	accessFailure?: GitHubError;
	gate?: Promise<void>;
	active = 0;
	peak = 0;
	etag = '"v1"';

	grant(token: string, value: InstalledRepository) {
		let repositories = this.access.get(token) ?? new Map();
		repositories.set(value.repository.name, value);
		this.access.set(token, repositories);
	}

	async installedRepository(token: string, _owner: string, name: string) {
		if (this.accessFailure) throw this.accessFailure;
		return this.access.get(token)?.get(name);
	}

	async pullRequest(
		token: string,
		_owner: string,
		_name: string,
		number: number,
		condition?: GitHubCondition,
	): Promise<GitHubConditional<GitHubPullRequestSummary>> {
		this.calls.push({ token, number, condition });
		this.active++;
		this.peak = Math.max(this.peak, this.active);
		try {
			await this.gate;
			if (this.fail) throw this.fail;
			if (condition?.ifNoneMatch === this.etag) return { notModified: true, etag: this.etag };
			return { ...pullSummary(number), etag: this.etag };
		} finally {
			this.active--;
		}
	}

	async issue(): Promise<GitHubConditional<GitHubIssueSummary>> {
		throw new GitHubError("not found", 404);
	}
}

describe("GitHub reference resolution", () => {
	it("refuses repositories outside the user's installation and missing permissions", async () => {
		let source = new FakeSource();
		source.grant("alice", {
			...installed("score"),
			installation: installation({ issues: false }),
		});
		let suspended = installed("suspended");
		suspended.installation = { ...suspended.installation, suspended: true };
		source.grant("alice", suspended);
		let unreadable = installed("unreadable");
		unreadable.repository.permissions.pull = false;
		source.grant("alice", unreadable);
		let references = new GitHubReferences(source);
		expect(
			await references.resolve("alice", [
				ref(1),
				ref(2, "issue"),
				ref(3, "pull", "elsewhere"),
				ref(4, "pull", "suspended"),
				ref(5, "pull", "unreadable"),
			]),
		).toEqual([
			{ status: "ok", summary: pullSummary(1) },
			{ status: "unavailable" },
			{ status: "unavailable" },
			{ status: "unavailable" },
			{ status: "unavailable" },
		]);
		expect(source.calls.map(call => call.number)).toEqual([1]);
	});

	it("serves cached summaries only after each user's own access check", async () => {
		let now = 0;
		let source = new FakeSource();
		source.grant("alice", installed("score"));
		let references = new GitHubReferences(source, { clock: () => now });
		expect((await references.resolve("alice", [ref(1)]))[0]!.status).toBe("ok");
		expect(await references.resolve("mallory", [ref(1)])).toEqual([{ status: "unavailable" }]);
		source.grant("bob", installed("score"));
		expect((await references.resolve("bob", [ref(1)]))[0]!.status).toBe("ok");
		expect(source.calls).toHaveLength(1);

		now = 60_001;
		expect((await references.resolve("bob", [ref(1)]))[0]!.status).toBe("ok");
		expect(source.calls).toHaveLength(2);
		expect(source.calls[1]).toEqual({
			token: "bob",
			number: 1,
			condition: { ifNoneMatch: '"v1"' },
		});
	});

	it("keys the cache by repository node identity, not by name", async () => {
		let source = new FakeSource();
		source.grant("alice", installed("score", "R_old"));
		source.grant("bob", installed("score", "R_new"));
		let references = new GitHubReferences(source);
		await references.resolve("alice", [ref(1)]);
		await references.resolve("bob", [ref(1)]);
		expect(source.calls.map(call => call.token)).toEqual(["alice", "bob"]);
	});

	it("coalesces identical requests and limits concurrent GitHub calls", async () => {
		let source = new FakeSource();
		source.grant("alice", installed("score"));
		source.grant("bob", installed("score"));
		let release!: () => void;
		source.gate = new Promise(resolve => {
			release = resolve;
		});
		let references = new GitHubReferences(source, { concurrency: 2 });
		let batch = Array.from({ length: 6 }, (_, index) => ref(index + 1));
		let first = references.resolve("alice", batch);
		let second = references.resolve("bob", batch);
		await Bun.sleep(0);
		expect(source.peak).toBe(2);
		release();
		let [alice, bob] = await Promise.all([first, second]);
		expect(alice.every(result => result.status === "ok")).toBe(true);
		expect(bob).toEqual(alice);
		expect(source.calls).toHaveLength(6);
		expect(source.peak).toBe(2);
	});

	it("reports rate limits and evicts summaries GitHub no longer serves", async () => {
		let now = 0;
		let source = new FakeSource();
		source.grant("alice", installed("score"));
		let references = new GitHubReferences(source, { clock: () => now });
		await references.resolve("alice", [ref(1)]);
		now = 60_001;
		source.fail = new GitHubError("slow down", 429);
		expect(await references.resolve("alice", [ref(1)])).toEqual([{ status: "rate-limited" }]);
		source.fail = new GitHubError("gone", 404);
		expect(await references.resolve("alice", [ref(1)])).toEqual([{ status: "unavailable" }]);
		source.fail = undefined;
		await references.resolve("alice", [ref(1)]);
		expect(source.calls.at(-1)!.condition).toEqual({});

		source.accessFailure = new GitHubError("slow down", 429);
		expect(await references.resolve("alice", [ref(2)])).toEqual([{ status: "rate-limited" }]);
	});

	it("propagates the user's own rejected token so the session can refresh", async () => {
		let source = new FakeSource();
		source.grant("alice", installed("score"));
		let references = new GitHubReferences(source);
		source.fail = new GitHubError("expired", 401);
		await expect(references.resolve("alice", [ref(1)])).rejects.toMatchObject({ status: 401 });
		source.fail = undefined;
		source.accessFailure = new GitHubError("expired", 401);
		await expect(references.resolve("alice", [ref(1)])).rejects.toMatchObject({ status: 401 });
	});

	it("bounds the cache", async () => {
		let source = new FakeSource();
		source.grant("alice", installed("score"));
		let references = new GitHubReferences(source, { capacity: 2 });
		await references.resolve("alice", [ref(1), ref(2), ref(3)]);
		await references.resolve("alice", [ref(3), ref(2)]);
		expect(source.calls).toHaveLength(3);
		await references.resolve("alice", [ref(1)]);
		expect(source.calls).toHaveLength(4);
	});
});
