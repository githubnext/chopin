import { github } from "./maintenance.mjs";

export function nextAction(snapshot) {
	if (snapshot.optedOut) return "opted-out";
	if (snapshot.parentReady === false) return "waiting-parent";
	if (snapshot.mergeable === false) return "conflict";
	if (snapshot.behind > 0) return "rebase";
	if (snapshot.behind !== 0 || snapshot.mergeable !== true) return "verify";
	let run = snapshot.run;
	if (
		!run || run.head_sha !== snapshot.head || run.event !== "pull_request"
		|| run.head_repository?.full_name !== snapshot.repository || run.status !== "completed"
	) return "waiting-ci";
	if (["failure", "timed_out", "action_required", "startup_failure"].includes(run.conclusion)) {
		return "repair";
	}
	return run.conclusion === "success" ? "ready" : "waiting-ci";
}

function included(pr, repository) {
	return pr.state === "open" && pr.head.repo?.full_name === repository;
}

function optedOut(pr) {
	return pr.labels.some((label) => label.name === "no-babysit");
}

export function inventory(repository, gh = github) {
	let listed = gh([
		"api",
		`repos/${repository}/pulls?state=open&sort=updated&direction=asc&per_page=100`,
		"--paginate",
		"--slurp",
	]).flat();
	let snapshots = new Map();
	for (let candidate of listed) {
		if (!included(candidate, repository)) continue;
		let pr = optedOut(candidate)
			? candidate
			: gh(["api", `repos/${repository}/pulls/${candidate.number}`]);
		if (!included(pr, repository)) continue;
		let snapshot = { repository, head: pr.head.sha, optedOut: optedOut(pr) };
		let row = {
			number: pr.number,
			head: pr.head.sha,
			branch: pr.head.ref,
			base: pr.base.ref,
			baseHead: null,
			parent: null,
			action: "opted-out",
			run: null,
		};
		if (!snapshot.optedOut) {
			row.baseHead = gh([
				"api",
				`repos/${repository}/commits/${encodeURIComponent(pr.base.ref)}`,
			]).sha;
			let comparison = gh([
				"api",
				`repos/${repository}/compare/${row.baseHead}...${pr.head.sha}`,
			]);
			let { workflow_runs: runs } = gh([
				"api",
				`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=1`,
			]);
			row.run = runs[0] ?? null;
			snapshot = {
				...snapshot,
				behind: comparison.behind_by,
				mergeable: pr.mergeable,
				run: row.run,
			};
		}
		snapshots.set(pr.number, { row, snapshot, changed: false });
	}
	// Refresh after all reads: an intervening branch update invalidates the observed evidence.
	let currentBases = new Map();
	for (let [number, entry] of snapshots) {
		if (entry.snapshot.optedOut) continue;
		let fresh = gh(["api", `repos/${repository}/pulls/${number}`]);
		if (!included(fresh, repository)) {
			snapshots.delete(number);
			continue;
		}
		entry.snapshot.optedOut = optedOut(fresh);
		entry.changed = fresh.head.sha !== entry.row.head || fresh.head.ref !== entry.row.branch
			|| fresh.base.ref !== entry.row.base;
		entry.snapshot.mergeable = fresh.mergeable;
		if (entry.changed || entry.snapshot.optedOut) continue;
		if (!currentBases.has(entry.row.base)) {
			currentBases.set(
				entry.row.base,
				gh([
					"api",
					`repos/${repository}/commits/${encodeURIComponent(entry.row.base)}`,
				]).sha,
			);
		}
		entry.changed ||= currentBases.get(entry.row.base) !== entry.row.baseHead;
		let { workflow_runs: runs } = gh([
			"api",
			`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${entry.row.head}&event=pull_request&per_page=1`,
		]);
		entry.row.run = runs[0] ?? null;
		entry.snapshot.run = entry.row.run;
	}
	let pending = new Map(snapshots);
	let rows = [];
	for (let entry of pending.values()) {
		let parents = [...snapshots.values()].filter((parent) =>
			parent.row.number !== entry.row.number && parent.row.branch === entry.row.base
		);
		entry.row.parent = parents.length === 1 ? parents[0].row.number : null;
		entry.changed ||= parents.length > 1;
	}
	while (pending.size) {
		let progressed = false;
		for (let [number, entry] of pending) {
			if (pending.has(entry.row.parent)) continue;
			let parent = snapshots.get(entry.row.parent);
			entry.row.action = entry.snapshot.optedOut
				? "opted-out"
				: entry.changed
				? "verify"
				: nextAction({
					...entry.snapshot,
					parentReady: parent ? parent.row.action === "ready" : undefined,
				});
			rows.push(entry.row);
			pending.delete(number);
			progressed = true;
		}
		if (!progressed) {
			// Cycles have no safe parent-first ordering; defer them for another inspection.
			for (let entry of pending.values()) {
				entry.row.action = entry.snapshot.optedOut ? "opted-out" : "verify";
				rows.push(entry.row);
			}
			break;
		}
	}
	return rows;
}
