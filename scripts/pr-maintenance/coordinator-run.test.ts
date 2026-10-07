import { expect, test } from "bun:test";
import { runCoordinator } from "./coordinator-run.mjs";
import { sealState } from "./state-store.mjs";
let key = "x".repeat(32);
let rows = [1, 2].map(number => ({
	number,
	head: "a".repeat(40),
	baseHead: "b".repeat(40),
	branch: `feature-${number}`,
	base: "main",
	action: "repair",
	run: null,
}));
function config(extra = {}) {
	let writes = [];
	let payload =
		sealState({ schemaVersion: 1, repository: "a/b", revision: 0, prs: {} }, key).payload;
	return {
		repository: "a/b",
		key,
		inspect: async () => rows,
		confirm: async (_repo, row) => row,
		request: async (method, path, body) => {
			if (method !== "GET") writes.push({ path, body });
			if (path.includes("/permission")) return { permission: "read" };
			if (path.includes("/commits/")) return { committer: { type: "Bot" } };
			return { workflow_runs: [] };
		},
		store: {
			load: async () => ({ sha: "a".repeat(40), payload }),
			save: async (_previous, next) => {
				writes.push("state");
				payload = next;
				return { sha: "a".repeat(40), payload };
			},
		},
		report: async () => {
			writes.push("report");
		},
		writes,
		...extra,
	};
}
test("disabled is read only without key or store", async () => {
	let value = config({ key: undefined, store: undefined });
	await runCoordinator(value);
	expect(value.writes).toEqual([]);
});
test("enabled canary reserves only selected PR", async () => {
	let value = config({ enabled: true, prs: "1" });
	let result = await runCoordinator(value);
	expect(result.dispatches.map(item => item.number)).toEqual([1]);
	expect(result.payload.prs[2].active).toBeNull();
});
test("unauthorized manual retry fails before mutations", async () => {
	let value = config({
		enabled: true,
		prs: "all",
		event: { inputs: { pr: "1" }, sender: { login: "reader" } },
		eventName: "workflow_dispatch",
	});
	await expect(runCoordinator(value)).rejects.toThrow("not authorized");
	expect(value.writes).toEqual([]);
});

test("authenticated result must match actual GitHub run identity", async () => {
	let { begin, initialState } = await import("./state.mjs");
	let { sealResult } = await import("./actions.mjs");
	let attempt = "12345678-1234-1234-1234-123456789abc";
	let active = begin(
		initialState(
			{ number: 1, head: rows[0].head, baseHead: rows[0].baseHead, action: "repair" },
			1,
		),
		attempt,
		2,
	);
	let payload = { schemaVersion: 1, repository: "a/b", revision: 0, prs: { 1: active } };
	let value = config({
		enabled: true,
		prs: "1",
		now: 3,
		store: {
			load: async () => ({ sha: "a".repeat(40), payload }),
			save: async (_old, next) => ({ sha: "b".repeat(40), payload: next }),
		},
		downloadResult: async () =>
			sealResult({
				repository: "a/b",
				number: 1,
				attempt,
				runId: "999",
				outcome: { kind: "applied", head: "c".repeat(40) },
			}, key),
	});
	value.request = async (_method, path) =>
		path.includes("/runs?")
			? {
				workflow_runs: [{
					id: 22,
					display_title: `PR maintenance #1 [${attempt}]`,
					path: ".github/workflows/pr-readiness-worker.lock.yml",
					event: "workflow_dispatch",
					repository: { full_name: "a/b" },
					head_repository: { full_name: "a/b" },
					status: "completed",
				}],
			}
			: {};
	let result = await runCoordinator(value);
	expect(result.payload.prs[1].transientCount).toBe(1);
	expect(result.payload.prs[1].head).toBe(rows[0].head);
});

test("registered proposal head authored by PAT does not reset episode", async () => {
	let { begin, initialState, registerProposal } = await import("./state.mjs");
	let attempt = "12345678-1234-1234-1234-123456789abc";
	let head = "c".repeat(40);
	let active = registerProposal(
		begin(
			initialState(
				{ number: 1, head: rows[0].head, baseHead: rows[0].baseHead, action: "repair" },
				1,
			),
			attempt,
			2,
		),
		attempt,
		head,
	);
	let payload = { schemaVersion: 1, repository: "a/b", revision: 0, prs: { 1: active } };
	let commits = 0;
	let value = config({
		enabled: true,
		prs: "1",
		now: 3,
		inspect: async () => [{ ...rows[0], head }],
		store: {
			load: async () => ({ sha: "a".repeat(40), payload }),
			save: async (_old, next) => ({ sha: "b".repeat(40), payload: next }),
		},
		request: async (_method, path) => {
			if (path.includes("/commits/")) {
				commits++;
				return { committer: { type: "User" } };
			}
			return { workflow_runs: [] };
		},
	});
	let result = await runCoordinator(value);
	expect(commits).toBe(0);
	expect(result.payload.prs[1].episode).toBe(active.episode);
});

test("fresh closed, opted-out, changed-base, or reporting failure skips CI writes", async () => {
	for (let scenario of ["closed", "opted-out", "base", "report"]) {
		let waiting = { ...rows[0], action: "waiting-ci" };
		let value = config({ enabled: true, prs: "1", inspect: async () => [waiting] });
		value.request = async (method, path, body) => {
			if (method !== "GET") value.writes.push({ path, body });
			if (path.includes("/runs?")) return { workflow_runs: [] };
			if (path.includes("/commits/")) {
				return { sha: scenario === "base" ? "changed" : waiting.baseHead };
			}
			return {
				state: scenario === "closed" ? "closed" : "open",
				labels: scenario === "opted-out" ? [{ name: "no-babysit" }] : [],
				head: { sha: waiting.head, ref: waiting.branch, repo: { full_name: "a/b" } },
				base: { ref: waiting.base },
			};
		};
		value.report = async () => {
			if (scenario === "report") throw new Error("unavailable");
			value.writes.push("report");
		};
		await runCoordinator(value);
		expect(value.writes).toEqual(["state"]);
	}
});

test("authenticated opt-out cleans only owned labels without comments or CI", async () => {
	let opted = { ...rows[0], action: "opted-out", baseHead: null };
	let value = config({ enabled: true, prs: "1", inspect: async () => [opted], report: undefined });
	value.request = async (method, path, body) => {
		if (method !== "GET") {
			value.writes.push({ method, path, body });
			return null;
		}
		if (path.includes("/runs?")) return { workflow_runs: [] };
		if (path.includes("/pulls/")) {
			return {
				state: "open",
				labels: [{ name: "no-babysit" }, { name: "maintenance:working" }, { name: "feature" }],
				head: { sha: opted.head, ref: opted.branch, repo: { full_name: "a/b" } },
				base: { ref: opted.base },
			};
		}
		throw new Error(`Unexpected read ${path}`);
	};
	await runCoordinator(value);
	expect(value.writes).toEqual(["state", {
		method: "DELETE",
		path: "/repos/a/b/issues/1/labels/maintenance%3Aworking",
		body: undefined,
	}]);
});

test("expired trusted queued/in-progress workers cancel without releasing lock", async () => {
	let { begin, initialState, attachRun } = await import("./state.mjs");
	let attempt = "12345678-1234-1234-1234-123456789abc";
	for (
		let scenario of [
			"queued",
			"in_progress",
			"early",
			"failure",
			"foreign",
			"mismatch",
			"invalid-state",
		]
	) {
		let state = attachRun(
			begin(
				initialState({
					number: 1,
					head: rows[0].head,
					baseHead: rows[0].baseHead,
					action: "repair",
				}, 1),
				attempt,
				2,
			),
			attempt,
			"22",
		);
		let payload = { schemaVersion: 1, repository: "a/b", revision: 0, prs: { 1: state } };
		if (scenario === "invalid-state") state.active.createdAt = -1;
		let cancellations = [];
		let value = config({
			enabled: true,
			prs: "1",
			now: scenario === "early" ? 100 : 45 * 60_000 + 2,
			store: {
				load: async () => ({ sha: "a".repeat(40), payload }),
				save: async (_old, next) => ({ sha: "b".repeat(40), payload: next }),
			},
			request: async (method, path) => {
				if (method === "POST" && path.endsWith("/cancel")) {
					cancellations.push(path);
					if (scenario === "failure") throw new Error("credential-secret");
					return null;
				}
				if (path.includes("/runs?")) {
					return {
						workflow_runs: [{
							id: 22,
							display_title: `PR maintenance #1 [${
								scenario === "mismatch" ? "87654321-1234-1234-1234-123456789abc" : attempt
							}]`,
							path: ".github/workflows/pr-readiness-worker.lock.yml",
							event: "workflow_dispatch",
							repository: { full_name: scenario === "foreign" ? "foreign/repo" : "a/b" },
							head_repository: { full_name: "a/b" },
							status: scenario === "queued" ? "queued" : "in_progress",
						}],
					};
				}
				return {};
			},
		});
		if (["foreign", "mismatch", "invalid-state"].includes(scenario)) {
			await expect(runCoordinator(value)).rejects.toThrow();
			expect(cancellations).toEqual([]);
		} else {
			let result = await runCoordinator(value);
			expect(cancellations).toHaveLength(scenario === "early" ? 0 : 1);
			expect(result.payload.prs[1].active?.id).toBe(attempt);
			expect(result.dispatches).toEqual([]);
			if (scenario === "failure") {
				expect(result.errors.join(" ")).not.toContain("credential-secret");
			}
		}
	}
});

test("failure logs sampled only for confirmed current-head failed CI and errors stay null", async () => {
	let run = {
		id: 12,
		head_sha: rows[0].head,
		head_branch: rows[0].branch,
		head_repository: { full_name: "a/b" },
		path: ".github/workflows/ci.yml",
		event: "pull_request",
		status: "completed",
		conclusion: "failure",
	};
	for (let scenario of ["failed", "throws", "pending", "stale", "foreign", "green", "disabled"]) {
		let calls = 0;
		let current = {
			...run,
			...(scenario === "pending" ? { status: "queued" } : {}),
			...(scenario === "stale" ? { head_sha: "c".repeat(40) } : {}),
			...(scenario === "foreign" ? { head_repository: { full_name: "foreign/repo" } } : {}),
			...(scenario === "green" ? { conclusion: "success" } : {}),
		};
		let value = config({
			enabled: scenario !== "disabled",
			prs: "1",
			inspect: async () => [{ ...rows[0], run: current }],
			getFailureFingerprint: async () => {
				calls++;
				if (scenario === "throws") throw new Error("secret-value");
				return "d".repeat(64);
			},
		});
		let result = await runCoordinator(value);
		expect(calls).toBe(["failed", "throws"].includes(scenario) ? 1 : 0);
		if (scenario !== "disabled") {
			expect(result.rows[0].failureFingerprint).toBe(scenario === "failed" ? "d".repeat(64) : null);
		}
		expect(JSON.stringify(result)).not.toContain("secret-value");
	}
});
