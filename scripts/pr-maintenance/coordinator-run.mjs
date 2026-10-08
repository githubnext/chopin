import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequest, openResult } from "./actions.mjs";
import { coordinate } from "./coordinator.mjs";
import { inventory } from "./inventory.mjs";
import { createInventoryRead } from "./inventory-read.mjs";
import { getFailureFingerprint, isFailedCI } from "./failures.mjs";
import { inspectReadiness } from "./readiness.mjs";
import { createStateStore } from "./state-store.mjs";
import { validateState } from "./state.mjs";

let workflow = "pr-readiness-worker.lock.yml";
async function downloadResult(repository, runId) {
	let directory = mkdtempSync(join(tmpdir(), "chopin-result-"));
	try {
		execFileSync("gh", [
			"run",
			"download",
			runId,
			"--repo",
			repository,
			"--name",
			"pr-maintenance-result",
			"--dir",
			directory,
		], { stdio: "pipe" });
		let fd = openSync(join(directory, "result.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			let stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid result artifact");
			let bytes = readFileSync(fd);
			if (bytes.length > 256 * 1024) throw new Error("Oversized result artifact");
			return JSON.parse(bytes);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export async function runCoordinator(config = {}) {
	let repository = config.repository ?? process.env.GITHUB_REPOSITORY;
	if (!/^[-\w.]+\/[-\w.]+$/.test(repository ?? "")) {
		throw new Error("GITHUB_REPOSITORY is required");
	}
	let enabled = config.enabled ?? process.env.PR_READINESS_ENABLED === "true";
	if (!enabled) return { rows: [], payload: null, dispatches: [], errors: [] };
	let selection = config.prs ?? process.env.PR_READINESS_PRS ?? "";
	if (selection !== "all" && !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(selection)) {
		throw new Error("PR_READINESS_PRS must specify canary PR numbers or all");
	}
	let numbers = new Set(selection.split(",").map(Number));
	let selected = number => selection === "all" || numbers.has(number);
	let key = config.key ?? process.env.PR_MAINTENANCE_STATE_KEY;
	if (typeof key !== "string" || Buffer.byteLength(key) < 32) {
		throw new Error(
			"PR_MAINTENANCE_STATE_KEY must contain at least 32 bytes; authenticated state must preexist",
		);
	}
	let request = config.request ?? createRequest(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
	// A worker dispatched with GITHUB_TOKEN cannot wake this coordinator via workflow_run.
	let dispatchRequest = config.dispatchRequest
		?? (config.request ? request : createRequest(process.env.PR_MAITENANCE_TOKEN));
	let rows = await (config.inspect
		?? (() => inventory(repository, createInventoryRead(repository), selected)))();
	rows = rows.filter(row => selected(row.number));
	let confirm = config.confirm ?? inspectReadiness;
	rows = await Promise.all(rows.map(row => confirm(repository, row, request)));
	// Reapply parent ordering using confirmed checks, not the advisory inventory.
	for (let row of rows) {
		if (
			row.parent && rows.find(parent => parent.number === row.parent)?.action !== "ready"
			&& row.action !== "opted-out"
		) row.action = "waiting-parent";
	}
	let store = config.store ?? createStateStore(repository, key, request);
	let previous = await store.load();
	let now = config.now ?? Date.now();
	if (!Number.isFinite(now) || now < 0) throw new Error("Invalid coordinator timestamp");
	for (let [number, state] of Object.entries(previous.payload.prs)) {
		validateState(state);
		if (String(state.number) !== number) throw new Error("PR state identity mismatch");
	}
	let root = `/repos/${repository}`;
	let event = config.event
		?? (process.env.GITHUB_EVENT_PATH
			? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
			: {});
	let retryPR = null;
	if (
		(config.eventName ?? process.env.GITHUB_EVENT_NAME) === "workflow_dispatch" && event.inputs?.pr
	) {
		let actor = event.sender?.login;
		if (typeof actor !== "string" || !actor) {
			throw new Error("Manual retry actor is not authorized");
		}
		let permission = await request(
			"GET",
			`${root}/collaborators/${encodeURIComponent(actor)}/permission`,
		);
		if (!["write", "maintain", "admin"].includes(permission.permission)) {
			throw new Error("Manual retry actor is not authorized");
		}
		retryPR = Number(event.inputs.pr);
		if (!Number.isSafeInteger(retryPR) || !selected(retryPR)) {
			throw new Error("Manual retry PR is outside canary selection");
		}
	}
	let humanChanges = [];
	for (let row of rows) {
		let state = previous.payload.prs[row.number];
		if (!state || row.head === state.head || row.head === state.active?.proposalHead) continue;
		let commit = await request("GET", `${root}/commits/${row.head}`);
		if (commit.committer?.type === "User") humanChanges.push(row.number);
	}
	for (let row of rows) {
		row.failureFingerprint = null;
		if (
			row.action !== "repair" || !selected(row.number)
			|| !isFailedCI(repository, row.run, row.head, row.branch)
		) continue;
		try {
			let fingerprint = await (config.getFailureFingerprint ?? getFailureFingerprint)(
				repository,
				row.run,
			);
			if (/^[0-9a-f]{64}$/.test(fingerprint ?? "")) row.failureFingerprint = fingerprint;
		} catch { /* Missing trusted logs do not invent a repeated failure identity. */ }
	}
	let active = Object.values(previous.payload.prs).filter(state => state.active);
	let rawRuns = [];
	let unacknowledged = active.filter(state => state.active.runId === null);
	if (unacknowledged.length) {
		let earliest = Math.min(...unacknowledged.map(state => state.active.createdAt));
		let since = new Date(Math.max(0, earliest - 5 * 60_000)).toISOString();
		for (let page = 1; page <= 5; page++) {
			let response = await request(
				"GET",
				`${root}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=${
					encodeURIComponent(`>=${since}`)
				}&per_page=100&page=${page}`,
			);
			if (!Array.isArray(response.workflow_runs)) throw new Error("Invalid worker run inventory");
			rawRuns.push(...response.workflow_runs);
			if (response.workflow_runs.length < 100) break;
			if (page === 5) throw new Error("Recent worker run inventory exceeds safe page limit");
		}
	}
	for (let state of active) {
		let id = state.active.runId;
		if (!id || rawRuns.some(run => String(run.id) === id)) continue;
		let run = await request("GET", `${root}/actions/runs/${id}`);
		if (String(run.id) !== id) throw new Error("Known worker run identity mismatch");
		rawRuns.push(run);
	}
	let trustedRuns = [];
	for (let run of rawRuns) {
		let match =
			/^PR maintenance #([1-9][0-9]*) \[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/
				.exec(run.display_title ?? "");
		if (!match) {
			if (
				Object.values(previous.payload.prs).some(state => state.active?.runId === String(run.id))
			) throw new Error("Known worker run title mismatch");
			continue;
		}
		let owner = Object.values(previous.payload.prs).find(state =>
			state.active && (state.active.id === match[2] || state.active.runId === String(run.id))
		);
		if (owner && owner.number !== Number(match[1])) {
			throw new Error("Worker run PR identity mismatch");
		}
		let state = previous.payload.prs[match[1]];
		if (
			!state?.active || (state.active.id !== match[2] && state.active.runId !== String(run.id))
		) continue;
		if (
			run.path !== `.github/workflows/${workflow}` || run.event !== "workflow_dispatch"
			|| run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
		) throw new Error("Worker run provenance mismatch");
		if (
			state.active.id !== match[2]
			|| (state.active.runId !== null && state.active.runId !== String(run.id))
		) throw new Error("Worker run attempt identity mismatch");
		let known = { id: String(run.id), attempt: match[2], status: run.status };
		if (run.status === "completed") {
			try {
				let packet = await (config.downloadResult ?? downloadResult)(repository, known.id);
				known.outcome = openResult(packet, {
					repository,
					number: Number(match[1]),
					attempt: known.attempt,
					runId: known.id,
				}, key);
			} catch { /* Missing authenticated result remains a transient coordinator failure. */ }
		}
		trustedRuns.push(known);
	}
	let timeoutErrors = [];
	let identities = new Set();
	for (let run of trustedRuns) {
		if (identities.has(run.id) || identities.has(run.attempt)) {
			throw new Error("Duplicate trusted worker run");
		}
		identities.add(run.id);
		identities.add(run.attempt);
	}
	for (let run of trustedRuns) {
		let state = Object.values(previous.payload.prs).find(state => state.active?.id === run.attempt);
		if (
			!["queued", "in_progress"].includes(run.status) || now - state.active.createdAt < 45 * 60_000
		) continue;
		try {
			await request("POST", `${root}/actions/runs/${run.id}/cancel`);
		} catch {
			timeoutErrors.push(
				`PR #${state.number}: expired worker cancellation unavailable; active lock retained`,
			);
		}
	}

	let result = await coordinate({
		store: { load: async () => previous, save: (...args) => store.save(...args) },
		inspect: async () =>
			rows.map(row =>
				selected(row.number) || row.action === "opted-out" ? row : { ...row, action: "verify" }
			),
		listRuns: async () => trustedRuns,
		dispatch: intent =>
			dispatchRequest("POST", `${root}/actions/workflows/${workflow}/dispatches`, {
				ref: "main",
				inputs: { pr: String(intent.number), attempt: intent.attempt },
			}),
		now,
		newId: config.newId ?? randomUUID,
		humanChanges,
		retryPR,
		enabled: true,
	});
	result.errors.push(...timeoutErrors);
	if (result.errors.some(error => error.includes("reservation failed"))) return { ...result, rows };
	let report = config.report ?? (await import("./presentation.mjs")).reportMaintenance;
	for (let row of rows) {
		if (!selected(row.number)) continue;
		try {
			let pr = await request("GET", `${root}/pulls/${row.number}`);
			if (pr.state !== "open") continue;
			let optedOut = pr.labels?.some(label =>
				(typeof label === "string" ? label : label.name) === "no-babysit"
			);
			let state = result.payload.prs[row.number];
			if (optedOut !== (state.status === "opted-out")) continue;
			let base = optedOut
				? null
				: await request("GET", `${root}/commits/${encodeURIComponent(row.base)}`);
			if (
				pr.head.sha !== row.head || pr.head.ref !== row.branch || pr.base.ref !== row.base
				|| (!optedOut && base.sha !== row.baseHead)
				|| pr.head.repo?.full_name !== repository
			) throw new Error("PR changed before reporting");
			await report({
				repository,
				state: result.payload.prs[row.number],
				request,
				key,
				pr,
				ciUrl: row.run?.html_url ?? null,
			});
		} catch {
			result.errors.push(`PR #${row.number}: maintenance reporting unavailable`);
			continue;
		}
		if (row.action !== "waiting-ci" || result.payload.prs[row.number]?.active) continue;
		try {
			if (!row.run) {
				await dispatchRequest("POST", `${root}/actions/workflows/ci.yml/dispatches`, {
					ref: row.branch,
				});
			} else if (
				row.run.status === "completed" && ["cancelled", "timed_out"].includes(row.run.conclusion)
			) await dispatchRequest("POST", `${root}/actions/runs/${row.run.id}/rerun`);
		} catch {
			result.errors.push(`PR #${row.number}: CI trigger unavailable`);
		}
	}
	return { ...result, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runCoordinator().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
		console.error("PR readiness coordinator failed; check configuration and trusted state");
		process.exitCode = 1;
	});
}
