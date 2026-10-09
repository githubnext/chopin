import { requiresRebase } from "./inventory.mjs";

let jobsRequired = ["format, lint, types, tests", "e2e", "container"];
let failures = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export async function inspectReadiness(repository, row, request) {
	let result = { ...row };
	let root = `/repos/${repository}`;
	let get = (path) => request("GET", `${root}${path}`);
	let rules;
	let settings;
	async function replayAction(pr) {
		if (pr.rebaseable === true) return null;
		rules ??= await pages(`/rules/branches/${encodeURIComponent(row.base)}`);
		settings ??= await get("");
		let required = requiresRebase(settings, rules);
		return required === null ? "verify" : required && pr.rebaseable !== true
			? (pr.rebaseable === false ? "rebase" : "verify")
			: null;
	}
	async function pages(path, field) {
		let values = [];
		for (let page = 1;; page++) {
			let response = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
			let items = field ? response[field] : response;
			if (!Array.isArray(items)) throw new Error("Invalid readiness response");
			values.push(...items);
			if (items.length < 100) return values;
		}
	}
	try {
		let pr = await get(`/pulls/${row.number}`);
		if (pr.state !== "open" || pr.draft !== false) return null;
		if (
			pr.state === "open" && pr.head.repo?.full_name === repository
			&& pr.labels?.some(label => (typeof label === "string" ? label : label.name) === "no-babysit")
		) return { ...result, action: "opted-out" };
		if (row.action === "opted-out") return { ...result, action: "verify" };
		let base = await get(`/commits/${encodeURIComponent(row.base)}`);
		if (
			pr.state !== "open" || pr.head.repo?.full_name !== repository
			|| pr.head.sha !== row.head || pr.head.ref !== row.branch || pr.base.ref !== row.base
			|| base.sha !== row.baseHead
		) return { ...result, action: "verify" };
		if (
			!["ready", "waiting-ci", "repair", "waiting-parent", "rebase", "conflict"]
				.includes(row.action)
		) {
			return result;
		}
		if (pr.mergeable === false) return { ...result, action: "conflict" };
		if (pr.mergeable !== true) return { ...result, action: "verify" };
		let comparison = await get(`/compare/${base.sha}...${row.head}`);
		if (!Number.isSafeInteger(comparison.behind_by) || comparison.behind_by < 0) {
			return { ...result, action: "verify" };
		}
		let branch = await get(`/branches/${encodeURIComponent(row.base)}`);
		if (branch.commit?.sha !== row.baseHead) return { ...result, action: "verify" };
		let protection = branch.protection;
		if (protection?.enabled !== true && protection?.enabled !== false) {
			throw new Error("Unknown classic protection");
		}
		rules ??= await pages(`/rules/branches/${encodeURIComponent(row.base)}`);
		let replay = await replayAction(pr);
		if (
			!replay && comparison.behind_by > 0 && (
				protection?.enabled === true && protection.required_status_checks?.strict === true
				|| rules.some(rule =>
					rule.type === "required_status_checks"
					&& rule.parameters?.strict_required_status_checks_policy === true
				)
			)
		) replay = "rebase";
		if (replay) {
			let fresh = await get(`/pulls/${row.number}`);
			if (fresh.state !== "open" || fresh.draft !== false) return null;
			let currentBase = await get(`/commits/${encodeURIComponent(row.base)}`);
			if (
				fresh.labels?.some(label =>
					(typeof label === "string" ? label : label.name) === "no-babysit"
				)
			) {
				return { ...result, action: "opted-out" };
			}
			if (
				fresh.state !== "open" || fresh.head.repo?.full_name !== repository
				|| fresh.head.sha !== row.head || fresh.head.ref !== row.branch
				|| fresh.base.ref !== row.base
				|| currentBase.sha !== row.baseHead || fresh.mergeable !== true
				|| fresh.rebaseable !== pr.rebaseable
			) replay = "verify";
			return { ...result, action: replay };
		}
		let runs = await pages(`/actions/workflows/ci.yml/runs?head_sha=${row.head}`, "workflow_runs");
		result.run = runs.filter(run =>
			run.head_sha === row.head && run.head_branch === row.branch
			&& run.head_repository?.full_name === repository && run.path === ".github/workflows/ci.yml"
			&& ["pull_request", "workflow_dispatch"].includes(run.event)
		)
			.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
		let required = [];
		if (protection?.enabled === true) {
			let checks = protection.required_status_checks?.checks;
			let contexts = protection.required_status_checks?.contexts;
			if (
				!Array.isArray(checks) || !Array.isArray(contexts)
				|| contexts.some(context => !checks.some(check => check.context === context))
				|| checks.some(check => !Object.hasOwn(check, "app_id"))
			) throw new Error("Unknown classic check requirements");
			required.push(
				...checks.map(check => ({ context: check.context, integration_id: check.app_id })),
			);
		}
		for (let rule of rules) {
			if (rule.type !== "required_status_checks") continue;
			if (!Array.isArray(rule.parameters?.required_status_checks)) {
				throw new Error("Invalid rules requirements");
			}
			required.push(...rule.parameters.required_status_checks);
		}
		let missing = false;
		let failed = false;
		if (required.length) {
			let checks = await pages(`/commits/${row.head}/check-runs`, "check_runs");
			let statuses = await pages(`/commits/${row.head}/status`, "statuses");
			if (!Array.isArray(statuses)) throw new Error("Invalid statuses");
			for (let requirement of required) {
				if (typeof requirement.context !== "string" || !requirement.context) {
					throw new Error("Invalid required context");
				}
				let check = checks.filter(check =>
					check.name === requirement.context
					&& (requirement.integration_id == null || check.app?.id === requirement.integration_id)
				)
					.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
				let status = requirement.integration_id == null
					? statuses.find(status => status.context === requirement.context)
					: null;
				let conclusion = check
					? (check.status === "completed" ? check.conclusion : "pending")
					: status?.state;
				failed ||= failures.has(conclusion) || conclusion === "error";
				missing ||= conclusion !== "success";
			}
		}
		let run = result.run;
		if (run && run.status !== "completed") result.action = "waiting-ci";
		else if (failed || (run?.status === "completed" && failures.has(run.conclusion))) {
			result.action = "repair";
		} else if (!run || run.status !== "completed" || run.conclusion !== "success" || missing) {
			result.action = "waiting-ci";
		} else {
			let jobs = await pages(`/actions/runs/${run.id}/jobs?filter=latest`, "jobs");
			result.action = jobsRequired.every(name =>
					jobs.some(job =>
						job.name === name
						&& job.status === "completed" && job.conclusion === "success"
					)
				)
				? "ready"
				: "waiting-ci";
		}
		let fresh = await get(`/pulls/${row.number}`);
		if (fresh.state !== "open" || fresh.draft !== false) return null;
		let currentBase = await get(`/commits/${encodeURIComponent(row.base)}`);
		if (
			fresh.state === "open"
			&& fresh.labels?.some(label =>
				(typeof label === "string" ? label : label.name) === "no-babysit"
			)
		) return { ...result, action: "opted-out" };
		if (
			fresh.state !== "open" || fresh.head.repo?.full_name !== repository
			|| fresh.head.sha !== row.head || fresh.base.ref !== row.base || fresh.head.ref !== row.branch
			|| currentBase.sha !== row.baseHead
		) result.action = "verify";
		else if (fresh.mergeable === false) result.action = "conflict";
		else if (fresh.mergeable !== true) result.action = "verify";
		else {
			let replay = await replayAction(fresh);
			if (replay) result.action = replay;
		}
		return result;
	} catch {
		return { ...result, action: "verify" };
	}
}
