import { execFileSync } from "node:child_process";

export function github(args) {
	return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

export function eligible(pr, repository) {
	return pr.state === "open" && pr.base.ref === "main" && pr.head.ref !== "main"
		&& pr.head.repo?.full_name === repository
		&& !pr.labels.some((label) => label.name === "no-babysit");
}

function openPullRequests(repository, gh) {
	return gh([
		"api",
		`repos/${repository}/pulls?state=open&base=main&sort=updated&direction=asc&per_page=100`,
		"--paginate",
		"--slurp",
	]).flat();
}

function reported(repository, number, marker, gh) {
	let comments = gh([
		"api",
		`repos/${repository}/issues/${number}/comments?per_page=100`,
		"--paginate",
		"--slurp",
	]).flat();
	return comments.some((comment) => comment.body?.includes(marker));
}

export function selectFailures(repository, gh = github) {
	let candidates = [];
	for (let listed of openPullRequests(repository, gh)) {
		if (!eligible(listed, repository)) continue;
		let pr = gh(["api", `repos/${repository}/pulls/${listed.number}`]);
		if (!eligible(pr, repository)) continue;
		let { workflow_runs: runs } = gh([
			"api",
			`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=1`,
		]);
		let run = runs[0];
		if (
			!run || run.head_sha !== pr.head.sha || run.event !== "pull_request"
			|| run.head_repository?.full_name !== repository || run.status !== "completed"
			|| !["failure", "timed_out"].includes(run.conclusion)
		) continue;
		if (reported(repository, pr.number, `<!-- pr-ci-fix:${pr.head.sha} -->`, gh)) continue;
		// GitHub caps a PR's commit listing at 250; read the actual tip and its parent.
		let tip = gh(["api", `repos/${repository}/commits/${pr.head.sha}`]);
		let canFix = true;
		if (tip.commit.message.startsWith("[ci-fix] ") && tip.parents[0]) {
			let parent = gh(["api", `repos/${repository}/commits/${tip.parents[0].sha}`]);
			canFix = !parent.commit.message.startsWith("[ci-fix] ");
		}
		candidates.push({
			number: pr.number,
			head: pr.head.sha,
			branch: pr.head.ref,
			run: run.id,
			canFix,
		});
		if (candidates.length === 3) break;
	}
	return candidates;
}

export function rebasePullRequests(repository, gh = github) {
	let base = gh(["api", `repos/${repository}/commits/main`]).sha;
	let results = [];
	for (let listed of openPullRequests(repository, gh)) {
		if (!eligible(listed, repository)) continue;
		let pr = gh(["api", `repos/${repository}/pulls/${listed.number}`]);
		if (!eligible(pr, repository)) continue;
		let comparison = gh(["api", `repos/${repository}/compare/${base}...${pr.head.sha}`]);
		if (comparison.behind_by === 0) continue;
		try {
			gh([
				"api",
				"graphql",
				"-f",
				"query=mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid,updateMethod: REBASE}){pullRequest{id}}}",
				"-f",
				`pullRequestId=${pr.node_id}`,
				"-f",
				`expectedHeadOid=${pr.head.sha}`,
			]);
			results.push({ number: pr.number, status: "rebased" });
		} catch (error) {
			let message = error?.stderr === undefined ? String(error) : String(error.stderr);
			if (/expected.*head|head.*changed/i.test(message)) {
				results.push({ number: pr.number, status: "changed during rebase; skipped" });
				continue;
			}
			if (!/conflict|unable to rebase/i.test(message)) throw error;
			let marker = `<!-- pr-rebase:${pr.head.sha}:${base} -->`;
			if (!reported(repository, pr.number, marker, gh)) {
				gh([
					"api",
					`repos/${repository}/issues/${pr.number}/comments`,
					"--method",
					"POST",
					"-f",
					`body=${marker}\nPR babysitter could not rebase this branch cleanly onto main. The branch is unchanged. Please resolve the rebase conflict locally; automation will try again after the branch changes.`,
				]);
			}
			results.push({ number: pr.number, status: "blocked" });
		}
	}
	return results;
}
