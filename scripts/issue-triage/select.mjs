import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export let routingLabels = [
	"triage/agent-candidate",
	"triage/human-response",
	"triage/needs-info",
	"triage/backlog-note",
];

function github(path) {
	return JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}));
}

function internalAuthor(issue) {
	return ["OWNER", "MEMBER", "COLLABORATOR"].includes(issue.author_association);
}

export function selectIssues(repository, event, gh = github) {
	if (event.issue?.pull_request || event.comment?.user.type === "Bot") return [];
	let issues = event.issue
		? gh(`repos/${repository}/issues/${event.issue.number}`).flat()
		: gh(`repos/${repository}/issues?state=open&per_page=100`).flat();
	let candidates = [];
	issues.sort((a, b) => {
		return Number(internalAuthor(a)) - Number(internalAuthor(b))
			|| a.created_at.localeCompare(b.created_at) || a.number - b.number;
	});
	for (let issue of issues) {
		if (issue.pull_request || issue.state !== "open" || issue.locked || issue.user.type === "Bot") {
			continue;
		}
		if (issue.labels.some((label) => ["no-triage", "spam"].includes(label.name))) continue;
		let internal = internalAuthor(issue);
		// Internal bookmarks need labels, without a bot comment to track each unchanged note.
		if (
			!event.issue && internal && issue.labels.some((label) => routingLabels.includes(label.name))
		) continue;
		let comments = gh(`repos/${repository}/issues/${issue.number}/comments?per_page=100`).flat();
		let humanComments = comments.filter((comment) => comment.user.type !== "Bot");
		let fingerprint = createHash("sha256").update(JSON.stringify([
			issue.title,
			issue.body,
			humanComments.map(({ id, body, updated_at }) => ({ id, body, updated_at })),
		])).digest("hex").slice(0, 20);
		let marker = `<!-- issue-triage:${issue.number}:${fingerprint} -->`;
		if (
			comments.some((comment) =>
				comment.user.login === "github-actions[bot]" && comment.user.type === "Bot"
				&& comment.body.includes(marker)
			)
		) continue;
		candidates.push({
			...issue,
			internal,
			comments: humanComments,
			marker,
		});
		if (candidates.length === 5) break;
	}
	return candidates;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	let repository = process.env.GITHUB_REPOSITORY;
	if (!repository) throw new Error("GITHUB_REPOSITORY is required");
	let event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	let candidates = selectIssues(repository, event);
	mkdirSync("/tmp/gh-aw/data", { recursive: true });
	writeFileSync("/tmp/gh-aw/data/issue-triage.json", JSON.stringify(candidates));
	if (process.env.GITHUB_OUTPUT) {
		let metadata = candidates.map(({ number, internal, marker, updated_at }) => ({
			number,
			internal,
			marker,
			updated_at,
		}));
		appendFileSync(process.env.GITHUB_OUTPUT, `candidates=${JSON.stringify(metadata)}\n`);
		appendFileSync(process.env.GITHUB_OUTPUT, `has_candidates=${candidates.length > 0}\n`);
	}
	let summary = candidates.map((issue) =>
		`- #${issue.number}: ${issue.internal ? "internal" : "external"}`
	).join("\n")
		|| "No issues need triage; the agent is skipped.";
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
	}
}
