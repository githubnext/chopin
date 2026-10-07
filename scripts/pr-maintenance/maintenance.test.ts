import { expect, test } from "bun:test";
import { eligible, rebasePullRequests, selectFailures } from "./maintenance.mjs";

let repository = "githubnext/chopin";
let pr = {
	number: 42,
	node_id: "PR_42",
	state: "open",
	draft: true,
	labels: [],
	head: { sha: "head", ref: "feature", repo: { full_name: repository } },
	base: { ref: "main" },
};
let failedRun = {
	id: 123,
	head_sha: "head",
	status: "completed",
	conclusion: "failure",
	event: "pull_request",
	head_repository: { full_name: repository },
};

function fixture(overrides: Record<string, unknown> = {}) {
	let writes: string[][] = [];
	let reads: Record<string, unknown> = {
		pulls: [[pr]],
		"pulls/42": pr,
		"commits/main": { sha: "main" },
		"compare/main...head": { behind_by: 1 },
		runs: { workflow_runs: [failedRun] },
		"issues/42/comments": [[]],
		"pulls/42/commits": [[{ commit: { message: "Feature" } }]],
		...overrides,
	};
	let history = (reads["pulls/42/commits"] as { commit: { message: string } }[][]).flat();
	reads["commits/head"] ??= { ...history.at(-1), parents: [{ sha: "parent" }] };
	reads["commits/parent"] ??= history.at(-2);
	let gh = (args: string[]) => {
		if (args.includes("graphql") || args.includes("POST")) {
			writes.push(args);
			return {};
		}
		let path = args[1]!.replace(`repos/${repository}/`, "").split("?")[0]!;
		if (path === "actions/workflows/ci.yml/runs") path = "runs";
		if (!(path in reads)) throw new Error(`Unexpected read: ${args.join(" ")}`);
		return reads[path];
	};
	return { gh, writes };
}

test("includes same-repository draft PRs without changing draft status", () => {
	expect(eligible(pr, repository)).toBe(true);
	expect(pr.draft).toBe(true);
});

test("excludes forks, closed PRs, other bases, main itself, and opted-out PRs", () => {
	for (
		let change of [
			{ state: "closed" },
			{ base: { ref: "release" } },
			{ head: { ...pr.head, ref: "main" } },
			{ head: { ...pr.head, repo: { full_name: "other/chopin" } } },
			{ head: { ...pr.head, repo: null } },
			{ labels: [{ name: "no-babysit" }] },
		]
	) expect(eligible({ ...pr, ...change }, repository)).toBe(false);
});

test("selects failed CI on the current PR head", () => {
	let { gh } = fixture();
	expect(selectFailures(repository, gh)).toEqual([
		{ number: 42, head: "head", branch: "feature", run: 123, canFix: true },
	]);
});

test("ignores stale, successful, pending, cancelled, and foreign runs", () => {
	for (
		let change of [
			{ head_sha: "old" },
			{ status: "in_progress" },
			{ conclusion: "success" },
			{ conclusion: "cancelled" },
			{ event: "push" },
			{ head_repository: { full_name: "other/chopin" } },
		]
	) {
		let { gh } = fixture({ runs: { workflow_runs: [{ ...failedRun, ...change }] } });
		expect(selectFailures(repository, gh)).toEqual([]);
	}
});

test("reports each commit once and only looks at the newest CI run", () => {
	let { gh } = fixture({
		"issues/42/comments": [[{ body: "<!-- pr-ci-fix:head -->" }]],
	});
	expect(selectFailures(repository, gh)).toEqual([]);
	let newer = fixture({
		runs: { workflow_runs: [{ ...failedRun, conclusion: "success" }, failedRun] },
	});
	expect(selectFailures(repository, newer.gh)).toEqual([]);
});

test("allows diagnosis but stops fixing after two consecutive automation commits", () => {
	let { gh } = fixture({
		"pulls/42/commits": [[
			{ commit: { message: "Feature" } },
			{ commit: { message: "[ci-fix] First attempt" } },
			{ commit: { message: "[ci-fix] Second attempt" } },
		]],
	});
	expect(selectFailures(repository, gh)[0]?.canFix).toBe(false);
});

test("a human change resets the consecutive fix limit", () => {
	let { gh } = fixture({
		"pulls/42/commits": [[
			{ commit: { message: "[ci-fix] First attempt" } },
			{ commit: { message: "[ci-fix] Second attempt" } },
			{ commit: { message: "Correct the intended behavior" } },
		]],
	});
	expect(selectFailures(repository, gh)[0]?.canFix).toBe(true);
});

test("the fix limit uses the actual tip even if a PR's commit listing is truncated", () => {
	let { gh } = fixture({
		"commits/head": { commit: { message: "[ci-fix] Second" }, parents: [{ sha: "parent" }] },
		"commits/parent": { commit: { message: "[ci-fix] First" } },
	});
	expect(selectFailures(repository, gh)[0]?.canFix).toBe(false);
});

test("reads paginated PRs and caps the batch at three", () => {
	let prs = [42, 43, 44, 45].map((number) => ({ ...pr, number }));
	let { gh } = fixture();
	let calls: string[] = [];
	let paginated = (args: string[]) => {
		let path = args[1]!;
		calls.push(path);
		if (path.includes("/pulls?")) return [[prs[0]], prs.slice(1)];
		if (/\/pulls\/\d+$/.test(path)) return prs.find((item) => path.endsWith(`/${item.number}`));
		return gh(args.map((arg) => arg.replace(/\/(43|44|45)(?=\/|\?|$)/g, "/42")));
	};
	expect(selectFailures(repository, paginated).map((item) => item.number)).toEqual([42, 43, 44]);
	expect(calls.some((path) => path.includes("/45"))).toBe(false);
});

test("rebases with an expected head SHA rather than overwriting a newer branch", () => {
	let { gh, writes } = fixture();
	expect(rebasePullRequests(repository, gh)).toEqual([{ number: 42, status: "rebased" }]);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toContain("expectedHeadOid=head");
	expect(writes[0]).toContain("pullRequestId=PR_42");
	expect(writes[0]?.join(" ")).toContain("updateMethod: REBASE");
});

test("does not rebase branches already current with main", () => {
	let { gh, writes } = fixture({ "compare/main...head": { behind_by: 0 } });
	expect(rebasePullRequests(repository, gh)).toEqual([]);
	expect(writes).toEqual([]);
});

test("rechecks eligibility immediately before rebasing", () => {
	let { gh, writes } = fixture({ "pulls/42": { ...pr, state: "closed" } });
	expect(rebasePullRequests(repository, gh)).toEqual([]);
	expect(writes).toEqual([]);
});

test("an intervening head change is skipped without posting a conflict report", () => {
	let { gh, writes } = fixture();
	let result = rebasePullRequests(repository, (args) => {
		if (args.includes("graphql")) throw new Error("Expected head oid did not match");
		return gh(args);
	});
	expect(result).toEqual([{ number: 42, status: "changed during rebase; skipped" }]);
	expect(writes).toEqual([]);
});

test("permission failures stop the run instead of spamming PRs with conflict reports", () => {
	let { gh, writes } = fixture();
	expect(() =>
		rebasePullRequests(repository, (args) => {
			if (args.includes("graphql")) throw new Error("Resource not accessible by token");
			return gh(args);
		})
	).toThrow("Resource not accessible by token");
	expect(writes).toEqual([]);
});

test("a conflict leaves the branch untouched and reports the blocker once", () => {
	let { gh, writes } = fixture();
	let conflicted = (args: string[]) => {
		if (args.includes("graphql")) throw new Error("merge conflict between base and head");
		return gh(args);
	};
	expect(rebasePullRequests(repository, conflicted)[0]?.status).toBe("blocked");
	expect(writes).toHaveLength(1);
	expect(writes[0]?.join(" ")).toContain("<!-- pr-rebase:head:main -->");
	let alreadyReported = fixture({
		"issues/42/comments": [[{ body: "<!-- pr-rebase:head:main -->" }]],
	});
	rebasePullRequests(repository, (args) => {
		if (args.includes("graphql")) throw new Error("merge conflict");
		return alreadyReported.gh(args);
	});
	expect(alreadyReported.writes).toEqual([]);
});
