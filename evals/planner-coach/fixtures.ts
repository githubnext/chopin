import { repositoryTools } from "../../apps/server/src/agent/repository";
import { GITHUB_TOOL_SCHEMAS } from "../../apps/server/src/harness/github-tools";
import { repositoryFiles } from "./scenarios";

import type { Tools } from "./types";

export const fixtureCommit = "1111111111111111111111111111111111111111";

export const fixtureRepository = {
	id: "R_test",
	owner: "octo-org",
	name: "score",
	defaultBranch: "main",
};

/** Tool schemas remain production schemas; no fixture ever receives an HTTP client. */
export function frozenRepositoryTools(): Tools {
	let reads = repositoryTools();
	let fileEntries = Object.entries(repositoryFiles);
	return Object.fromEntries(
		Object.entries(reads).map(([name, original]) => [name, {
			...original,
			execute: async (raw: unknown) => {
				let input = raw as Record<string, unknown>;
				if (input.commit && input.commit !== fixtureCommit) {
					return "Error: this frozen repository contains only the fixture commit";
				}
				let output: unknown;
				switch (name) {
					case "read_repository_file": {
						let path = String(input.path);
						let content = repositoryFiles[path];
						if (!content) return `Error: ${path} is absent from the frozen repository`;
						let lines = content.trimEnd().split("\n");
						let start = Number(input.start ?? 1);
						let end = Math.min(Number(input.end ?? lines.length), lines.length);
						output = {
							path,
							ref: fixtureCommit,
							start,
							end,
							content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`)
								.join("\n"),
						};
						break;
					}
					case "list_repository_tree":
						output = {
							entries: fileEntries.filter(([path]) =>
								!input.prefix || path.startsWith(String(input.prefix))
							).slice(0, Number(input.limit ?? 200)).map(([path]) => ({ path, type: "blob" })),
							truncated: false,
						};
						break;
					case "search_repository": {
						let terms = String(input.terms).toLowerCase().split(/\s+/).filter(Boolean);
						output = {
							matches: fileEntries.filter(([path, content]) =>
								terms.some(term => `${path}\n${content}`.toLowerCase().includes(term))
							).slice(0, Number(input.limit ?? 20)).map(([path]) => ({ path })),
						};
						break;
					}
					case "repository_history":
						output = [];
						break;
					default:
						throw new Error(`Unknown repository fixture tool ${name}`);
				}
				return JSON.stringify(output);
			},
		}]),
	) as Tools;
}

export function frozenPullRequests(): Tools {
	return Object.fromEntries(
		Object.entries(GITHUB_TOOL_SCHEMAS).map((
			[name, schema],
		) => [name, {
			...schema,
			description: name === "list_pull_requests"
				? "List pull requests in the selected repository."
				: "Read one pull request in the selected repository: its details, diff, status, "
					+ "changed files, commits, review comments, reviews, issue comments, or check runs.",
			execute: async () =>
				name === "list_pull_requests"
					? "[]"
					: "Error: this frozen repository has no pull requests",
		}]),
	);
}
