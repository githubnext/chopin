import { afterEach, expect, test } from "bun:test";

import { clearGitHubReferences, FRESH_FOR, GitHubReferenceCache } from "./github-references";

import type {
	GitHubReference,
	GitHubReferenceResult,
	GitHubReferencesResponse,
} from "@chopin/protocol/github-reference";

let open: GitHubReferenceResult = {
	status: "ok",
	summary: {
		kind: "pull",
		owner: "octo-org",
		repository: "score",
		number: 1,
		url: "https://github.com/octo-org/score/pull/1",
		title: "Add document outline",
		author: null,
		labels: [],
		comments: 0,
		createdAt: "2026-09-01T12:00:00Z",
		updatedAt: "2026-09-01T12:00:00Z",
		closedAt: null,
		state: "open",
		draft: false,
		mergedAt: null,
		headBranch: "topic-1",
		baseBranch: "main",
	},
};

function pull(number: number): GitHubReference {
	return { owner: "octo-org", repository: "score", kind: "pull", number };
}

function harness() {
	let calls: string[][] = [];
	let timers: (() => void)[] = [];
	let time = 0;
	let store = new GitHubReferenceCache({
		channelId: "c1",
		fetch: async (_channel, keys) => {
			calls.push([...keys]);
			return { references: Object.fromEntries(keys.map(key => [key, open])) };
		},
		now: () => time,
		schedule: callback => void timers.push(callback),
	});
	let flush = async () => {
		for (let timer of timers.splice(0)) timer();
		await new Promise(resolve => setTimeout(resolve, 0));
	};
	return {
		calls,
		flush,
		store,
		advance: (ms: number) => (time += ms),
	};
}

afterEach(() => clearGitHubReferences());

test("links read together are fetched in one request, then answered from memory", async () => {
	let { calls, flush, store } = harness();
	let changes = 0;
	let stop = store.subscribe(() => changes++);
	expect(store.get(pull(1))).toEqual({ status: "loading" });
	store.get(pull(2));
	store.get(pull(1));
	await flush();
	expect(calls).toEqual([["octo-org/score/pull/1", "octo-org/score/pull/2"]]);
	expect(store.get(pull(1))).toEqual(open);
	expect(changes).toBe(1);
	await flush();
	expect(calls).toHaveLength(1);
	stop();
});

test("requests are split at the route's limit", async () => {
	let { calls, flush, store } = harness();
	for (let number = 1; number <= 25; number++) store.get(pull(number));
	await flush();
	expect(calls.map(keys => keys.length)).toEqual([20, 5]);
});

test("a stale answer is still shown while it is asked for again", async () => {
	let { advance, calls, flush, store } = harness();
	store.get(pull(1));
	await flush();
	advance(FRESH_FOR + 1);
	expect(store.get(pull(1))).toEqual(open);
	await flush();
	expect(calls).toHaveLength(2);
});

test("load settles with the answer, and a failed first request claims nothing", async () => {
	let { flush, store } = harness();
	let loaded = store.load(pull(3));
	await flush();
	expect(await loaded).toEqual(open);

	let failing = new GitHubReferenceCache({
		channelId: "c1",
		fetch: () => Promise.reject(new Error("offline")),
		schedule: callback => void setTimeout(callback, 0),
	});
	expect(await failing.load(pull(4))).toEqual({ status: "rate-limited" });
});

test("a failed revalidation keeps the answer it had", async () => {
	let time = 0;
	let fail = false;
	let store = new GitHubReferenceCache({
		channelId: "c1",
		fetch: async (_channel, keys) => {
			if (fail) throw new Error("offline");
			return { references: Object.fromEntries(keys.map(key => [key, open])) };
		},
		now: () => time,
		schedule: callback => void setTimeout(callback, 0),
	});
	expect(await store.load(pull(8))).toEqual(open);
	fail = true;
	time += FRESH_FOR + 1;
	expect(await store.load(pull(8))).toEqual(open);
	expect(store.get(pull(8))).toEqual(open);
});

test("signing out forgets every summary", async () => {
	let { flush, store } = harness();
	store.get(pull(1));
	await flush();
	clearGitHubReferences();
	expect(store.get(pull(1))).toEqual({ status: "loading" });
});

test("a pending load discards its answer when the session is invalidated", async () => {
	let timers: (() => void)[] = [];
	let keys: string[] = [];
	let answer!: (response: GitHubReferencesResponse) => void;
	let store = new GitHubReferenceCache({
		channelId: "c1",
		fetch: (_channel, requested) => {
			keys = [...requested];
			return new Promise(resolve => (answer = resolve));
		},
		schedule: callback => void timers.push(callback),
	});
	let loaded = store.load(pull(1));
	timers.shift()!();
	expect(keys).toEqual(["octo-org/score/pull/1"]);
	clearGitHubReferences();
	answer({ references: Object.fromEntries(keys.map(key => [key, open])) });
	expect(await loaded).toEqual({ status: "rate-limited" });
	expect(store.get(pull(1))).toEqual({ status: "loading" });
});
