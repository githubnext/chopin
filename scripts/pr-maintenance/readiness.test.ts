import { expect, test } from "bun:test";
import { inspectReadiness } from "./readiness.mjs";
let row = {
	number: 1,
	head: "abc",
	branch: "feature",
	base: "main",
	baseHead: "base",
	action: "ready",
};
function transport(options = {}) {
	return async (_method, path) => {
		if (path.includes("/pulls/")) {
			return {
				state: "open",
				head: { sha: "abc", ref: "feature", repo: { full_name: "a/b" } },
				base: { ref: "main" },
				mergeable: true,
				rebaseable: true,
			};
		}
		if (path.includes("/commits/main")) return { sha: "base" };
		if (path.includes("/compare/")) return { behind_by: 0 };
		if (path.startsWith("/repos/a/b/branches/")) {
			if (options.forbidden) {
				let error = new Error();
				error.status = 403;
				throw error;
			}
			return {
				commit: { sha: "base" },
				protection: {
					enabled: false,
					required_status_checks: { checks: [], contexts: [], enforcement_level: "off" },
				},
			};
		}
		if (path.includes("/rules/")) {
			return options.required
				? [{
					type: "required_status_checks",
					parameters: { required_status_checks: [{ context: "required", integration_id: 9 }] },
				}]
				: [];
		}
		if (path.includes("/check-runs")) {
			return {
				check_runs: [{
					name: "required",
					app: { id: options.wrongApp ? 8 : 9 },
					status: "completed",
					conclusion: options.failed ? "failure" : "success",
				}],
			};
		}
		if (path.includes("/status?")) return { statuses: [] };
		if (path.includes("/jobs?")) {
			return {
				jobs: ["format, lint, types, tests", "e2e", "container"].map(name => ({
					name,
					status: "completed",
					conclusion: options.skipped ? "skipped" : "success",
				})),
			};
		}
		if (path.includes("/runs?")) {
			return {
				workflow_runs: [{
					id: 2,
					head_sha: "abc",
					head_branch: "feature",
					head_repository: { full_name: "a/b" },
					path: ".github/workflows/ci.yml",
					event: options.foreign ? "push" : "workflow_dispatch",
					status: options.pending ? "queued" : "completed",
					conclusion: "success",
				}],
			};
		}
		throw new Error(path);
	};
}
test("requires actual successful configured CI jobs", async () => {
	expect((await inspectReadiness("a/b", row, transport())).action).toBe("ready");
	for (let option of ["skipped", "pending", "foreign"]) {
		expect((await inspectReadiness("a/b", row, transport({ [option]: true }))).action).toBe(
			"waiting-ci",
		);
	}
});

test("current green CI still needs replayable history when repository only permits rebase", async () => {
	for (let rebaseOnly of [true, false]) {
		let base = transport();
		let request = async (method, path) => {
			if (path === "/repos/a/b") {
				return {
					allow_rebase_merge: true,
					allow_squash_merge: !rebaseOnly,
					allow_merge_commit: !rebaseOnly,
				};
			}
			let response = await base(method, path);
			return path.includes("/pulls/") ? { ...response, rebaseable: false } : response;
		};
		expect((await inspectReadiness("a/b", row, request)).action)
			.toBe(rebaseOnly ? "rebase" : "ready");
	}
});

test("replay checks preserve fresh head, base, and opt-out guards", async () => {
	for (let change of ["head", "base", "opt-out", "unknown-policy", "unknown-replay"]) {
		let base = transport();
		let pulls = 0;
		let bases = 0;
		let request = async (method, path) => {
			if (path === "/repos/a/b") {
				return change === "unknown-policy" ? {} : {
					allow_rebase_merge: true,
					allow_squash_merge: false,
					allow_merge_commit: false,
				};
			}
			let response = await base(method, path);
			if (path.includes("/pulls/")) {
				let fresh = ++pulls > 1;
				return {
					...response,
					rebaseable: change === "unknown-replay" ? null : false,
					labels: fresh && change === "opt-out" ? [{ name: "no-babysit" }] : [],
					head: fresh && change === "head" ? { ...response.head, sha: "new" } : response.head,
				};
			}
			if (path.includes("/commits/main") && ++bases > 1 && change === "base") return { sha: "new" };
			return response;
		};
		expect((await inspectReadiness("a/b", row, request)).action)
			.toBe(change === "opt-out" ? "opted-out" : "verify");
	}
});

test("readiness catches replayability becoming false during successful CI inspection", async () => {
	let base = transport();
	let pulls = 0;
	let request = async (method, path) => {
		if (path === "/repos/a/b") {
			return { allow_rebase_merge: true, allow_squash_merge: false, allow_merge_commit: false };
		}
		let response = await base(method, path);
		return path.includes("/pulls/") ? { ...response, rebaseable: ++pulls === 1 } : response;
	};
	expect((await inspectReadiness("a/b", row, request)).action).toBe("rebase");
});

test("inventory rebase advice is freshly confirmed before scheduling history repair", async () => {
	for (
		let state of [
			{ rebaseable: null, behind: 0, mergeable: true, action: "verify" },
			{ rebaseable: true, behind: 0, mergeable: true, action: "ready" },
			{ rebaseable: false, behind: 0, mergeable: true, action: "rebase" },
			{ rebaseable: null, behind: 1, mergeable: true, action: "rebase" },
			{ rebaseable: true, behind: 1, mergeable: false, action: "conflict" },
		]
	) {
		let base = transport();
		let request = async (method, path) => {
			if (path === "/repos/a/b") {
				return { allow_rebase_merge: true, allow_squash_merge: false, allow_merge_commit: false };
			}
			if (path.includes("/compare/")) return { behind_by: state.behind };
			let response = await base(method, path);
			return path.includes("/pulls/")
				? { ...response, mergeable: state.mergeable, rebaseable: state.rebaseable }
				: response;
		};
		expect((await inspectReadiness("a/b", { ...row, action: "rebase" }, request)).action)
			.toBe(state.action);
	}
});
test("required rules are app bound and failures override green CI", async () => {
	expect((await inspectReadiness("a/b", row, transport({ required: true, failed: true }))).action)
		.toBe("repair");
	expect((await inspectReadiness("a/b", row, transport({ required: true, wrongApp: true }))).action)
		.toBe("waiting-ci");
	expect((await inspectReadiness("a/b", row, transport({ forbidden: true }))).action).toBe(
		"verify",
	);
});

test("fresh opt-out preserves null base identity and skips CI inspection", async () => {
	let calls = [];
	let request = async (_method, path) => {
		calls.push(path);
		return {
			state: "open",
			labels: [{ name: "no-babysit" }],
			head: { sha: "abc", ref: "feature", repo: { full_name: "a/b" } },
			base: { ref: "main" },
		};
	};
	expect(
		(await inspectReadiness("a/b", { ...row, action: "opted-out", baseHead: null }, request))
			.action,
	).toBe("opted-out");
	expect(calls).toHaveLength(1);
});
test("pending actual CI waits despite older required-check failure", async () => {
	expect(
		(await inspectReadiness("a/b", row, transport({ required: true, failed: true, pending: true })))
			.action,
	).toBe("waiting-ci");
});
test("child may become ready when freshly inspected parent becomes ready", async () => {
	expect((await inspectReadiness("a/b", { ...row, action: "waiting-parent" }, transport())).action)
		.toBe("ready");
});

test("contents-readable branch metadata preserves rules requirements without admin endpoint", async () => {
	let calls = [];
	let base = transport({ required: true, failed: true });
	let request = async (method, path) => {
		calls.push(path);
		return base(method, path);
	};
	expect((await inspectReadiness("a/b", row, request)).action).toBe("repair");
	expect(calls.some(path => path.includes("/protection/"))).toBe(false);
	expect(calls.some(path => path.includes("/branches/main"))).toBe(true);
	for (
		let protection of [{ enabled: true }, {
			enabled: true,
			required_status_checks: { checks: [], contexts: ["legacy"] },
		}]
	) {
		let inspect = async (method, path) =>
			path === "/repos/a/b/branches/main"
				? { commit: { sha: "base" }, protection }
				: base(method, path);
		expect((await inspectReadiness("a/b", row, inspect)).action).toBe("verify");
	}
});
