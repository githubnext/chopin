import { expect, test } from "bun:test";
import { eventTarget, runCoordinator } from "./coordinator-run.mjs";
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
test("schedule, main push, and manual sweep inspect all selected PRs", () => {
	let payload = { prs: {} };
	expect(eventTarget("schedule", {}, "a/b", payload)).toBeNull();
	expect(eventTarget("push", { ref: "refs/heads/main" }, "a/b", payload)).toBeNull();
	expect(eventTarget("workflow_dispatch", { inputs: {} }, "a/b", payload)).toBeNull();
	expect(eventTarget("push", { ref: "refs/heads/feature" }, "a/b", payload))
		.toEqual({ kind: "none" });
});

test("PR and CI events target verified identity, including CI with no pull_requests", () => {
	let payload = { prs: {} };
	let pr = {
		repository: { full_name: "a/b" },
		pull_request: { number: 2, head: { repo: { full_name: "a/b" } } },
	};
	expect(eventTarget("pull_request_target", pr, "a/b", payload))
		.toEqual({ kind: "prs", numbers: [2] });
	expect(eventTarget(
		"pull_request_target",
		{
			...pr,
			pull_request: { ...pr.pull_request, head: { repo: { full_name: "fork/repo" } } },
		},
		"a/b",
		payload,
	)).toEqual({ kind: "none" });
	let run = {
		status: "completed",
		repository: { full_name: "a/b" },
		head_repository: { full_name: "a/b" },
		path: ".github/workflows/ci.yml",
		event: "pull_request",
		head_branch: "feature-2",
		pull_requests: [],
	};
	expect(eventTarget("workflow_run", { workflow_run: run }, "a/b", payload))
		.toEqual({ kind: "branch", branch: "feature-2" });
	for (
		let change of [{ head_branch: "" }, { head_repository: { full_name: "fork/repo" } }, {
			path: ".github/workflows/other.yml",
		}]
	) {
		expect(eventTarget("workflow_run", { workflow_run: { ...run, ...change } }, "a/b", payload))
			.toEqual({ kind: "none" });
	}
});

test("worker event scope comes from signed active state, never its display title", () => {
	let run = {
		status: "completed",
		repository: { full_name: "a/b" },
		head_repository: { full_name: "a/b" },
		path: ".github/workflows/pr-readiness-worker.lock.yml",
		event: "workflow_dispatch",
		display_title: "PR maintenance #999 [forged]",
	};
	let payload = {
		prs: { 1: { number: 1, active: { id: "attempt" } }, 2: { number: 2, active: null } },
	};
	expect(eventTarget("workflow_run", { workflow_run: run }, "a/b", payload))
		.toEqual({ kind: "prs", numbers: [1] });
	expect(eventTarget("workflow_run", { workflow_run: run }, "a/b", { prs: {} }))
		.toEqual({ kind: "none" });
});
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
test("disabled reads no inventory, state, or GitHub data", async () => {
	let reads = [];
	let value = config({
		key: undefined,
		store: { load: async () => reads.push("state") },
		inspect: async () => reads.push("inventory"),
		request: async () => reads.push("GitHub"),
	});
	let result = await runCoordinator(value);
	expect(reads).toEqual([]);
	expect(result.rows).toEqual([]);
	expect(value.writes).toEqual([]);
});
test("an untrusted event target does no inventory or state write", async () => {
	let reads = [];
	let value = config({
		enabled: true,
		prs: "all",
		eventName: "workflow_run",
		event: { workflow_run: { path: ".github/workflows/ci.yml", head_branch: "" } },
		inspect: async () => reads.push("inventory"),
	});
	let result = await runCoordinator(value);
	expect(reads).toEqual([]);
	expect(value.writes).toEqual([]);
	expect(result.rows).toEqual([]);
});
test("enabled canary reserves only selected PR", async () => {
	let confirmed = [];
	let value = config({
		enabled: true,
		prs: "1",
		confirm: async (_repo, row) => {
			confirmed.push(row.number);
			return row;
		},
	});
	let result = await runCoordinator(value);
	expect(result.dispatches.map(item => item.number)).toEqual([1]);
	expect(confirmed).toEqual([1]);
	expect(result.rows.map(row => row.number)).toEqual([1]);
	expect(result.payload.prs[2]).toBeUndefined();
});
test("worker dispatch uses the built-in GitHub request", async () => {
	let calls = [];
	let value = config({
		enabled: true,
		prs: "1",
	});
	value.request = async (method, path, body) => {
		if (method === "POST") calls.push({ method, path, body });
		return { state: "closed" };
	};
	let result = await runCoordinator(value);
	expect(result.dispatches).toHaveLength(1);
	expect(calls).toHaveLength(1);
	expect(calls[0].method).toBe("POST");
	expect(calls[0].path).toBe(
		"/repos/a/b/actions/workflows/pr-readiness-worker.lock.yml/dispatches",
	);
	expect(calls[0].body.inputs.pr).toBe("1");
});
test("missing CI is dispatched with the built-in GitHub request", async () => {
	let dispatched = [];
	let waiting = { ...rows[0], action: "waiting-ci" };
	let value = config({
		enabled: true,
		prs: "1",
		inspect: async () => [waiting],
	});
	value.request = async (method, path, body) => {
		if (method === "POST") {
			dispatched.push({ method, path, body });
			return null;
		}
		if (path.includes("/pulls/")) {
			return {
				state: "open",
				labels: [],
				head: { sha: waiting.head, ref: waiting.branch, repo: { full_name: "a/b" } },
				base: { ref: waiting.base },
			};
		}
		if (path.includes("/commits/")) return { sha: waiting.baseHead };
		return { workflow_runs: [] };
	};
	await runCoordinator(value);
	expect(dispatched).toEqual([{
		method: "POST",
		path: "/repos/a/b/actions/workflows/ci.yml/dispatches",
		body: { ref: waiting.branch },
	}]);
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

test("authorized manual retry rediscovers runs before replacing an abandoned reservation", async () => {
	let { begin, initialState } = await import("./state.mjs");
	let attempt = "12345678-1234-1234-1234-123456789abc";
	let active = begin(
		initialState({
			number: 1,
			head: rows[0].head,
			baseHead: rows[0].baseHead,
			action: "repair",
		}, 1),
		attempt,
		2,
	);
	let payload = { schemaVersion: 1, repository: "a/b", revision: 0, prs: { 1: active } };
	let requests = [];
	let value = config({
		enabled: true,
		prs: "1",
		now: 5 * 60_000 + 2,
		event: { inputs: { pr: "1" }, sender: { login: "writer" } },
		eventName: "workflow_dispatch",
		store: {
			load: async () => ({ sha: "a".repeat(40), payload }),
			save: async (_old, next) => {
				payload = next;
				return { sha: "b".repeat(40), payload };
			},
		},
		request: async (method, path, body) => {
			requests.push({ method, path, body });
			if (path.includes("/permission")) return { permission: "write" };
			if (path.includes("/runs?")) return { workflow_runs: [] };
			return { state: "closed" };
		},
	});
	let result = await runCoordinator(value);
	expect(requests.find(call => call.path.includes("/runs?"))).toBeTruthy();
	expect(result.dispatches).toHaveLength(1);
	expect(result.payload.prs[1].active.id).not.toBe(attempt);
	expect(result.payload.prs[1].episode).toBe(2);
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

test("lost dispatch response is recovered from recent matching runs", async () => {
	let { sealResult } = await import("./actions.mjs");
	let dispatched = null;
	let listReads = [];
	let value = config({
		enabled: true,
		prs: "1",
		now: 60_000,
		request: async (method, path, body) => {
			if (path.includes("/runs?")) {
				listReads.push(path);
				return {
					workflow_runs: dispatched
						? [{
							id: 22,
							display_title: `PR maintenance #1 [${dispatched.attempt}]`,
							path: ".github/workflows/pr-readiness-worker.lock.yml",
							event: "workflow_dispatch",
							repository: { full_name: "a/b" },
							head_repository: { full_name: "a/b" },
							status: "completed",
						}]
						: [],
				};
			}
			if (method === "POST" && path.endsWith("/dispatches")) {
				dispatched = body.inputs;
				throw new Error("Lost dispatch response");
			}
			return {};
		},
		downloadResult: async (_repository, runId) =>
			sealResult({
				repository: "a/b",
				number: 1,
				attempt: dispatched.attempt,
				runId,
				outcome: { kind: "applied", head: "c".repeat(40) },
			}, key),
	});
	let first = await runCoordinator(value);
	expect(first.payload.prs[1].active?.runId).toBeNull();
	expect(first.errors.join(" ")).toContain("dispatch response unavailable");
	expect(listReads).toEqual([]);
	value.now++;
	let recovered = await runCoordinator(value);
	expect(listReads).toHaveLength(1);
	expect(listReads[0]).toContain("created=%3E%3D");
	expect(recovered.payload.prs[1].active).toBeNull();
	expect(recovered.payload.prs[1].head).toBe("c".repeat(40));
	expect(recovered.dispatches).toEqual([]);
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
		let reads = [];
		let value = config({
			enabled: true,
			prs: "1",
			now: scenario === "early" ? 100 : 45 * 60_000 + 2,
			store: {
				load: async () => ({ sha: "a".repeat(40), payload }),
				save: async (_old, next) => ({ sha: "b".repeat(40), payload: next }),
			},
			request: async (method, path) => {
				if (method === "GET") reads.push(path);
				if (method === "POST" && path.endsWith("/cancel")) {
					cancellations.push(path);
					if (scenario === "failure") throw new Error("credential-secret");
					return null;
				}
				if (path === "/repos/a/b/actions/runs/22") {
					return {
						id: 22,
						display_title: `PR maintenance #1 [${
							scenario === "mismatch" ? "87654321-1234-1234-1234-123456789abc" : attempt
						}]`,
						path: ".github/workflows/pr-readiness-worker.lock.yml",
						event: "workflow_dispatch",
						repository: { full_name: scenario === "foreign" ? "foreign/repo" : "a/b" },
						head_repository: { full_name: "a/b" },
						status: scenario === "queued" ? "queued" : "in_progress",
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
			expect(
				reads.filter(path => path.includes("/actions/")).every(path =>
					path === "/repos/a/b/actions/runs/22"
				),
			).toBe(true);
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
