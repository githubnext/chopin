import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { rebasePullRequests, selectFailures } from "./maintenance.mjs";

let repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error("GITHUB_REPOSITORY is required");

switch (process.argv[2]) {
	case "select": {
		let candidates = selectFailures(repository);
		mkdirSync("/tmp/gh-aw/data", { recursive: true });
		writeFileSync("/tmp/gh-aw/data/ci-failures.json", JSON.stringify(candidates));
		if (candidates.length === 0) {
			if (!process.env.GH_AW_SAFE_OUTPUTS) throw new Error("GH_AW_SAFE_OUTPUTS is required");
			appendFileSync(
				process.env.GH_AW_SAFE_OUTPUTS,
				JSON.stringify({ type: "noop", message: "No new current-head CI failures" }) + "\n",
			);
		}
		console.log(`Selected ${candidates.length} PRs for CI investigation`);
		break;
	}
	case "rebase": {
		let results = rebasePullRequests(repository);
		let summary = results.map((result) => `- #${result.number}: ${result.status}`).join("\n")
			|| "All eligible PRs are current with main.";
		console.log(summary);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
		break;
	}
	default:
		throw new Error("Use select or rebase");
}
