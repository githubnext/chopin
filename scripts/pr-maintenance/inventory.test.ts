import { expect, test } from "bun:test";
import { inventory, nextAction, requiresRebase } from "./inventory.mjs";

let repository = "githubnext/chopin";
let run = {
	id: 123,
	head_sha: "head-1",
	status: "completed",
	conclusion: "success",
	event: "pull_request",
	head_repository: { full_name: repository },
};
let snapshot = { repository, head: "head-1", behind: 0, mergeable: true, run };

function pull(number = 1, base = "main") {
	return {
		number,
		state: "open",
		draft: true,
		labels: [] as { name: string }[],
		mergeable: true,
		rebaseable: true,
		head: { sha: `head-${number}`, ref: `branch-${number}`, repo: { full_name: repository } },
		base: { ref: base },
	};
}

function fixture(pages = [[pull()]], overrides: Record<string, unknown> = {}) {
	let reads: Record<string, unknown> = { pulls: pages };
	for (let pr of pages.flat()) {
		reads[`pulls/${pr.number}`] = pr;
		reads[`commits/${encodeURIComponent(pr.base.ref)}`] = { sha: `base-${pr.base.ref}` };
		reads[`compare/base-${pr.base.ref}...${pr.head.sha}`] = { behind_by: 0 };
		reads[`runs/${pr.head.sha}`] = { workflow_runs: [{ ...run, head_sha: pr.head.sha }] };
	}
	Object.assign(reads, overrides);
	let calls: string[][] = [];
	let gh = (args: string[]) => {
		calls.push(args);
		if (args[0] !== "api" || args.includes("--method") || args.includes("graphql")) {
			throw new Error(`Unexpected write: ${args.join(" ")}`);
		}
		let endpoint = args[1]!.replace(`repos/${repository}/`, "");
		let path = endpoint.split("?")[0]!;
		if (path === "pulls") {
			expect(args).toContain("--paginate");
			expect(args).toContain("--slurp");
			expect(endpoint).not.toContain("base=");
		}
		if (path === "actions/workflows/ci.yml/runs") {
			let query = new URLSearchParams(endpoint.split("?")[1]);
			expect(query.get("event")).toBe("pull_request");
			path = `runs/${query.get("head_sha")}`;
		}
		if (!(path in reads)) throw new Error(`Unexpected read: ${endpoint}`);
		return reads[path];
	};
	return { gh, calls };
}

test("green CI cannot hide an unreplayable branch when its merge policy requires rebase", () => {
	let pr = { ...pull(), rebaseable: false };
	for (let method of ["rebase", "squash", "merge"]) {
		let { gh } = fixture([[pr]]);
		let read = (args: string[]) => {
			if (args[1] === `repos/${repository}`) {
				return { allow_rebase_merge: true, allow_squash_merge: true, allow_merge_commit: true };
			}
			if (args[1]?.includes("/rules/branches/")) {
				return [[{ type: "pull_request", parameters: { allowed_merge_methods: [method] } }]];
			}
			return gh(args);
		};
		expect(inventory(repository, read)[0]?.action).toBe(method === "rebase" ? "rebase" : "ready");
	}
});

test("effective merge methods intersect repository settings and branch rules conservatively", () => {
	let settings = { allow_rebase_merge: true, allow_squash_merge: true, allow_merge_commit: true };
	expect(requiresRebase(settings, [])).toBe(false);
	expect(requiresRebase({ ...settings, allow_squash_merge: false, allow_merge_commit: false }, []))
		.toBe(true);
	for (let method of ["REBASE", "SQUASH", "MERGE"]) {
		expect(
			requiresRebase(settings, [{ type: "merge_queue", parameters: { merge_method: method } }]),
		)
			.toBe(method === "REBASE");
	}
	expect(
		requiresRebase({ ...settings, allow_squash_merge: false }, [{
			type: "required_linear_history",
		}]),
	)
		.toBe(true);
	for (
		let rules of [
			[{ type: "merge_queue", parameters: {} }],
			[{ type: "pull_request", parameters: { allowed_merge_methods: ["unknown"] } }],
			[{ type: "pull_request", parameters: { allowed_merge_methods: [] } }],
		]
	) expect(requiresRebase(settings, rules)).toBeNull();
	expect(requiresRebase({}, [])).toBeNull();
	expect(requiresRebase({ ...settings, allow_rebase_merge: false }, [
		{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } },
	])).toBeNull();
});

test("an unreplayable parent still takes precedence over descendants and opt-outs", () => {
	let parent = { ...pull(), rebaseable: false };
	let { gh } = fixture([[pull(2, "branch-1"), parent]]);
	let read = (args: string[]) => {
		if (args[1] === `repos/${repository}`) {
			return { allow_rebase_merge: true, allow_squash_merge: false, allow_merge_commit: false };
		}
		if (args[1]?.includes("/rules/branches/")) return [[]];
		return gh(args);
	};
	expect(inventory(repository, read).map(row => [row.number, row.action]))
		.toEqual([[1, "rebase"], [2, "waiting-parent"]]);
	expect(nextAction({ ...snapshot, rebaseRequired: true, rebaseable: false, optedOut: true }))
		.toBe("opted-out");
	expect(nextAction({ ...snapshot, rebaseRequired: true, rebaseable: null })).toBe("verify");
	expect(nextAction({ ...snapshot, rebaseRequired: null, rebaseable: false })).toBe("verify");
});

test("readiness requires current successful aggregate CI, no lag, and known mergeability", () => {
	expect(nextAction(snapshot)).toBe("ready");
	for (let change of [{ mergeable: null }, { mergeable: undefined }, { behind: undefined }]) {
		expect(nextAction({ ...snapshot, ...change })).toBe("verify");
	}
	expect(nextAction({ ...snapshot, behind: 1 })).toBe("rebase");
	expect(nextAction({ ...snapshot, mergeable: false })).toBe("conflict");
	expect(nextAction({ ...snapshot, optedOut: true })).toBe("opted-out");
	expect(nextAction({ ...snapshot, parentReady: false })).toBe("waiting-parent");
});

test("stale, absent, pending, cancelled, skipped, and foreign CI never imply readiness", () => {
	for (
		let change of [
			{ head_sha: "old" },
			{ status: "queued" },
			{ status: "in_progress" },
			{ conclusion: "cancelled" },
			{ conclusion: "skipped" },
			{ conclusion: null },
			{ event: "push" },
			{ head_repository: { full_name: "someone/fork" } },
		]
	) expect(nextAction({ ...snapshot, run: { ...run, ...change } })).toBe("waiting-ci");
	expect(nextAction({ ...snapshot, run: null })).toBe("waiting-ci");
	for (let conclusion of ["failure", "timed_out", "action_required", "startup_failure"]) {
		expect(nextAction({ ...snapshot, run: { ...run, conclusion } })).toBe("repair");
	}
});

test("inventories every paginated same-repository draft without a batch cap", () => {
	let prs = Array.from({ length: 30 }, (_, index) => pull(index + 1));
	let { gh } = fixture([prs.slice(0, 10), prs.slice(10)]);
	let rows = inventory(repository, gh);
	expect(rows).toHaveLength(30);
	expect(rows[29]).toEqual({
		number: 30,
		head: "head-30",
		branch: "branch-30",
		base: "main",
		baseHead: "base-main",
		parent: null,
		action: "ready",
		run: { ...run, head_sha: "head-30" },
	});
});

test("excludes forks and inventories opt-out without any per-PR reads", () => {
	let optOut = { ...pull(1), labels: [{ name: "no-babysit" }] };
	let fork = { ...pull(2), head: { ...pull(2).head, repo: { full_name: "someone/fork" } } };
	let { gh, calls } = fixture([[optOut, fork]]);
	expect(inventory(repository, gh)).toEqual([{
		number: 1,
		head: "head-1",
		branch: "branch-1",
		base: "main",
		baseHead: null,
		parent: null,
		action: "opted-out",
		run: null,
	}]);
	expect(calls).toHaveLength(1);
});

test("refreshes closed PRs, opt-outs, fork identity, and moved heads before inspection", () => {
	let moved = { ...pull(4), head: { ...pull(4).head, sha: "new-head" } };
	let { gh } = fixture([[pull(1), pull(2), pull(3), pull(4)]], {
		"pulls/1": { ...pull(1), state: "closed" },
		"pulls/2": { ...pull(2), labels: [{ name: "no-babysit" }] },
		"pulls/3": { ...pull(3), head: { ...pull(3).head, repo: null } },
		"pulls/4": moved,
		"compare/base-main...new-head": { behind_by: 0 },
		"runs/new-head": { workflow_runs: [{ ...run, head_sha: "new-head" }] },
	});
	let rows = inventory(repository, gh);
	expect(rows.map((row) => [row.number, row.head, row.action])).toEqual([
		[2, "head-2", "opted-out"],
		[4, "new-head", "ready"],
	]);
});

test("uses the intended base and places a refreshed stack parent before descendants", () => {
	let parent = { ...pull(1), head: { ...pull(1).head, ref: "new-parent" } };
	let child = pull(2, "new-parent");
	let { gh } = fixture([[child, pull(1)]], { "pulls/1": parent });
	let rows = inventory(repository, gh);
	expect(rows.map((row) => [row.number, row.parent, row.baseHead, row.action])).toEqual([
		[1, null, "base-main", "ready"],
		[2, 1, "base-new-parent", "ready"],
	]);
});

test("descendants wait for a lagging, failed, pending, or opted-out parent", () => {
	for (
		let overrides of [
			{ "compare/base-main...head-1": { behind_by: 1 } },
			{ "runs/head-1": { workflow_runs: [{ ...run, conclusion: "failure" }] } },
			{ "runs/head-1": { workflow_runs: [{ ...run, status: "queued" }] } },
			{ "pulls/1": { ...pull(1), labels: [{ name: "no-babysit" }] } },
		]
	) {
		let { gh } = fixture([[pull(2, "branch-1"), pull(1)]], overrides);
		expect(inventory(repository, gh)[1]?.action).toBe("waiting-parent");
	}
});

test("only the latest CI run for the refreshed head affects advice", () => {
	let { gh } = fixture(undefined, {
		"runs/head-1": { workflow_runs: [{ ...run, status: "in_progress" }, run] },
	});
	expect(inventory(repository, gh)[0]?.action).toBe("waiting-ci");
});

test("a same-head CI rerun during inspection replaces earlier successful evidence", () => {
	let { gh } = fixture();
	let runReads = 0;
	let rerun = { ...run, id: 456, status: "queued", conclusion: null };
	let racing = (args: string[]) => {
		if (args[1]!.includes("actions/workflows/ci.yml/runs?") && ++runReads === 2) {
			return { workflow_runs: [rerun] };
		}
		return gh(args);
	};
	let rows = inventory(repository, racing);
	expect(rows[0]?.action).toBe("waiting-ci");
	expect(rows[0]?.run).toEqual(rerun);
});

test("a retargeted PR defers without reading its now-deleted old base", () => {
	let { gh } = fixture([[pull(1, "old-parent"), pull(2)]]);
	let refreshes = 0;
	let oldBaseReads = 0;
	let racing = (args: string[]) => {
		if (args[1] === `repos/${repository}/pulls/1` && ++refreshes === 2) return pull(1);
		if (args[1] === `repos/${repository}/commits/old-parent` && ++oldBaseReads > 1) {
			throw new Error("404 old-parent no longer exists");
		}
		return gh(args);
	};
	expect(inventory(repository, racing).map((row) => [row.number, row.action])).toEqual([
		[1, "verify"],
		[2, "ready"],
	]);
});

test("a head or base moving during inspection invalidates successful CI evidence", () => {
	for (let kind of ["head", "base"]) {
		let { gh } = fixture();
		let refreshes = 0;
		let baseReads = 0;
		let racing = (args: string[]) => {
			if (args[1] === `repos/${repository}/pulls/1` && ++refreshes === 2 && kind === "head") {
				return { ...pull(), head: { ...pull().head, sha: "new-head" } };
			}
			if (args[1] === `repos/${repository}/commits/main` && ++baseReads === 2 && kind === "base") {
				return { sha: "new-base" };
			}
			return gh(args);
		};
		expect(inventory(repository, racing)[0]?.action).toBe("verify");
	}
});

test("unknown mergeability after inspection prevents readiness", () => {
	let { gh } = fixture();
	let refreshes = 0;
	let racing = (args: string[]) => {
		if (args[1] === `repos/${repository}/pulls/1` && ++refreshes === 2) {
			return { ...pull(), mergeable: null };
		}
		return gh(args);
	};
	expect(inventory(repository, racing)[0]?.action).toBe("verify");
});

test("cyclic and ambiguous stacks defer rather than guessing a parent", () => {
	let cyclic = fixture([[pull(1, "branch-2"), pull(2, "branch-1")]]);
	expect(inventory(repository, cyclic.gh).map((row) => row.action)).toEqual(["verify", "verify"]);
	let duplicate = { ...pull(2), head: { ...pull(2).head, ref: "branch-1" } };
	let ambiguous = fixture([[pull(3, "branch-1"), pull(1), duplicate]]);
	expect(inventory(repository, ambiguous.gh)[0]?.action).toBe("verify");
});
