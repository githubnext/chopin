import { describe, expect, it } from "bun:test";

import { configuration } from "./client";
import { gate } from "./permissions";
import { repositoryTools } from "./repository";

import type { PermissionRequest, Tool } from "@github/copilot-sdk";

describe("hosted Copilot configuration", () => {
	it("exposes only explicit custom and MCP tools", () => {
		let tool = {
			name: "read_plan",
			description: "read",
			parameters: {},
			handler: () => "ok",
		} as Tool;
		let config = configuration(
			{ model: "model" },
			{ tools: [tool] },
			{
				token: "gho_owner",
				repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			},
		);

		expect(config.gitHubToken).toBe("gho_owner");
		expect(config.availableTools).toEqual(["mcp:*", "custom:*"]);
		expect(config.tools?.[0]?.skipPermission).toBe(false);
		expect(config.enableConfigDiscovery).toBe(false);
		expect(config.skipCustomInstructions).toBe(true);
		expect(config.enableHostGitOperations).toBe(false);
		expect(config.enableSkills).toBe(false);
		expect(config.skipEmbeddingRetrieval).toBe(true);
		expect(config.largeOutput).toEqual({ enabled: false });
		expect(config.mcpServers?.github).toMatchObject({
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: "Bearer gho_owner", "X-MCP-Readonly": "true" },
		});
		expect(config.customAgents?.[0]?.prompt).toContain("read_repository_file");
		expect(config.customAgents?.[0]?.prompt).not.toContain("You have `view`, `grep` and `glob`");
	});

	it("confines MCP and denies every host capability", async () => {
		let decide = gate({
			owner: "octo-org",
			repository: "score",
			tools: new Set(["read_plan"]),
		});
		expect(
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "get_pull_request",
				toolTitle: "Pull request",
				args: { owner: "octo-org", repo: "score" },
			} as PermissionRequest, { sessionId: "s" }),
		).toEqual({ kind: "approve-once" });
		expect(
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "get_pull_request",
				toolTitle: "Pull request",
				args: { owner: "other", repo: "private" },
			} as PermissionRequest, { sessionId: "s" }),
		).toMatchObject({ kind: "reject" });
		expect(
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "issue_read",
				toolTitle: "Issue",
				args: { owner: "octo-org", repo: "score", method: "get_sub_issues" },
			} as PermissionRequest, { sessionId: "s" }),
		).toMatchObject({ kind: "reject" });
		expect(
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "search_issues",
				toolTitle: "Search",
				args: { owner: "octo-org", repo: "score", query: "repo:other/private secret" },
			} as PermissionRequest, { sessionId: "s" }),
		).toMatchObject({ kind: "reject" });
		expect(
			await decide({ kind: "read", path: "/etc/passwd", intention: "read" } as PermissionRequest, {
				sessionId: "s",
			}),
		).toMatchObject({ kind: "reject" });
	});
});

describe("hosted repository tools", () => {
	it("binds every read to one repository and filters search results", async () => {
		let urls: URL[] = [];
		let tools = repositoryTools({
			token: "gho_owner",
			repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			fetch: async input => {
				let url = new URL(String(input));
				urls.push(url);
				if (url.pathname.includes("/contents/")) {
					return Response.json({
						type: "file",
						encoding: "base64",
						content: Buffer.from("one\ntwo").toString("base64"),
					});
				}
				if (url.pathname.includes("/git/trees/")) {
					return Response.json({
						tree: [{ path: "src/a.ts", type: "blob", size: 10 }],
						truncated: false,
					});
				}
				if (url.pathname === "/search/code") {
					return Response.json({
						items: [
							{ path: "src/a.ts", html_url: "url", repository: { node_id: "R_repo" } },
							{ path: "secret", repository: { node_id: "R_other" } },
						],
					});
				}
				return Response.json([{
					sha: "abc",
					commit: { message: "change", author: { name: "Mona", date: "today" } },
				}]);
			},
		});
		let call = (name: string, input: unknown) => {
			let tool = tools.find(value => value.name === name)!;
			return (tool.handler as (raw: unknown) => Promise<string>)(input);
		};

		expect(await call("read_repository_file", { path: "src/a.ts" })).toContain("1: one");
		expect(await call("list_repository_tree", {})).toContain("src/a.ts");
		let searched = await call("search_repository", { terms: "symbol" });
		expect(searched).toContain("src/a.ts");
		expect(searched).not.toContain("secret");
		expect(await call("repository_history", {})).toContain("change");
		expect(
			urls.filter(url => url.pathname !== "/search/code").every(url =>
				url.pathname.startsWith("/repos/octo-org/score/")
			),
		).toBe(true);
		expect(urls.find(url => url.pathname === "/search/code")!.searchParams.get("q"))
			.toContain("repo:octo-org/score");
	});

	it("refuses paths that can escape the repository", async () => {
		let tools = repositoryTools({
			token: "token",
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			fetch: async () => Response.json({}),
		});
		let read = tools.find(tool => tool.name === "read_repository_file")!;
		let result = await (read.handler as (raw: unknown) => Promise<string>)({ path: "../secret" });
		expect(result).toContain("relative repository path");
	});
});
