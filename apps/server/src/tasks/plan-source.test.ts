import { expect, test } from "bun:test";
import { planSourceFor, restorePlanSources, validBranch, withPlanSource } from "./plan-source";

let commit = (c: string) => c.repeat(40);

test("a plan source's branch follows git's branch name rules", () => {
	for (let name of ["main", "chopin/plan-1", "plans/a_b.c-2", "x"]) {
		expect(validBranch(name)).toBe(true);
	}
	for (
		let name of [
			"",
			"refs/heads/main",
			"-main",
			"a..b",
			"a//b",
			"/a",
			"a/",
			"a.",
			".a",
			"a/.b",
			"a.lock",
			"a/b.lock/c",
			"a@{1}",
			"@",
			"HEAD",
			"a b",
			"a~1",
			"a^",
			"a:b",
			"a?",
			"a*",
			"a[b",
			"a\\b",
			"a\x01",
			"x".repeat(256),
		]
	) {
		expect(validBranch(name)).toBe(false);
	}
});

test("a build uses the newest source recorded at or before its revision", () => {
	let sources = withPlanSource([], { revision: 3, branch: "p", commit: commit("a") }).sources;
	sources = withPlanSource(sources, { revision: 7, branch: "p", commit: commit("b") }).sources;
	expect(planSourceFor(sources, 2)).toBeUndefined();
	expect(planSourceFor(sources, 3)?.commit).toBe(commit("a"));
	expect(planSourceFor(sources, 6)?.commit).toBe(commit("a"));
	expect(planSourceFor(sources, 9)?.commit).toBe(commit("b"));
});

test("recording the same source again changes nothing and a new commit replaces it", () => {
	let first = { revision: 4, branch: "p", commit: commit("a") };
	let sources = withPlanSource([], first).sources;
	expect(withPlanSource(sources, first)).toEqual({ sources, changed: false });
	let moved = withPlanSource(sources, { ...first, commit: commit("c") });
	expect(moved.changed).toBe(true);
	expect(moved.sources).toEqual([{ ...first, commit: commit("c") }]);
	// An earlier revision recorded late keeps the list in revision order.
	let earlier = withPlanSource(moved.sources, { revision: 2, branch: "p", commit: commit("d") });
	expect(earlier.sources.map(item => item.revision)).toEqual([2, 4]);
});

test("a document keeps the newest twenty sources", () => {
	let sources = withPlanSource([], { revision: 0, branch: "p", commit: commit("a") }).sources;
	for (let revision = 1; revision < 25; revision++) {
		sources = withPlanSource(sources, { revision, branch: "p", commit: commit("a") }).sources;
	}
	expect(sources.map(item => item.revision)).toEqual(
		Array.from({ length: 20 }, (_, index) => index + 5),
	);
});

test("stored sources restore only in order, valid and no newer than the document", () => {
	let stored = [
		{ revision: 1, branch: "p", commit: commit("a") },
		{ revision: 5, branch: "p", commit: commit("b") },
	];
	expect(restorePlanSources(undefined, 0)).toEqual([]);
	expect(restorePlanSources(stored, 5)).toEqual(stored);
	expect(() => restorePlanSources(stored, 4)).toThrow();
	expect(() => restorePlanSources(stored.toReversed(), 5)).toThrow();
	expect(() => restorePlanSources([{ ...stored[0], commit: "abc" }], 5)).toThrow();
	expect(() => restorePlanSources([{ ...stored[0], branch: "a..b" }], 5)).toThrow();
});
