import { describe, expect, it } from "bun:test";

import {
	assertWorkerTools,
	auditPublicResearchTools,
	openWorker,
	plannerConfiguration,
	publicResearchConfiguration,
	RUNTIME_ENV,
	workerConfiguration,
} from "./client";
import { gate, publicResearchGate, terminalGate } from "./permissions";
import { repositoryTools } from "./repository";

import type { PermissionRequest, Tool } from "@github/copilot-sdk";

async function webSearchTools(input: { serverName: string }) {
	expect(input).toEqual({ serverName: "github-mcp-server" });
	return { tools: [{ name: "web_search" }, { name: "search_repositories" }] };
}

describe("hosted Copilot configuration", () => {
	it("exposes only explicit custom and MCP tools", () => {
		let tool = {
			name: "read_plan",
			description: "read",
			parameters: {},
			handler: () => "ok",
		} as Tool;
		let config = plannerConfiguration(
			{ model: "model" },
			{ tools: [tool] },
			{
				token: "ghu_owner",
				repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			},
		);

		expect(config.gitHubToken).toBe("ghu_owner");
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
			headers: { Authorization: "Bearer ghu_owner", "X-MCP-Readonly": "true" },
		});
		expect(config.customAgents?.[0]?.prompt).toContain("read_repository_file");
		expect(config.customAgents?.[0]?.prompt).not.toContain("You have `view`, `grep` and `glob`");
	});

	it("gives a worker only its terminal result tool", async () => {
		let result = {
			name: "submit_job_result",
			description: "submit",
			parameters: {},
			handler: () => "ok",
		} as Tool;
		let options = {
			token: "ghu_owner",
			name: "chopin-document-summary",
			prompt: "Summarize the supplied document and submit one result.",
			result,
			maxAiCredits: 32,
		};
		let config = workerConfiguration({ model: "model" }, options);
		expect(() => workerConfiguration({ model: "model" }, { ...options, maxAiCredits: 29 }))
			.toThrow("at least 30");

		expect(config.gitHubToken).toBe("ghu_owner");
		expect(config.enableConfigDiscovery).toBe(false);
		expect(config.streaming).toBe(false);
		expect(config.sessionLimits).toEqual({ maxAiCredits: 32 });
		expect(config.availableTools).toEqual(["custom:submit_job_result"]);
		expect(config.tools).toHaveLength(1);
		expect(config.tools?.[0]).toMatchObject({
			name: "submit_job_result",
			skipPermission: false,
			isTerminal: true,
		});
		expect(config.mcpServers).toEqual({});
		expect(config.customAgents).toHaveLength(1);
		expect(config.customAgents?.[0]).toMatchObject({
			name: "chopin-document-summary",
			prompt: "Summarize the supplied document and submit one result.",
			infer: false,
		});
		expect(config.customAgents?.[0]?.tools).toBeUndefined();

		let decide = terminalGate("submit_job_result");
		expect(
			await decide(
				{ kind: "custom-tool", toolName: "submit_job_result" } as PermissionRequest,
				{ sessionId: "worker" },
			),
		).toEqual({ kind: "approve-once" });
		expect(
			await decide(
				{ kind: "custom-tool", toolName: "read_plan" } as PermissionRequest,
				{ sessionId: "worker" },
			),
		).toMatchObject({ kind: "reject" });
		expect(
			await decide(
				{ kind: "url", url: "https://example.com" } as PermissionRequest,
				{ sessionId: "worker" },
			),
		).toMatchObject({ kind: "reject" });
	});

	it("fails worker capability audits closed", () => {
		let result = { name: "submit_job_result", description: "submit" };
		let web = {
			name: "web_search",
			description: "search",
			namespacedName: "github-mcp-server/web_search",
			mcpServerName: "github-mcp-server",
			mcpToolName: "web_search",
		};
		expect(() => assertWorkerTools([result], "submit_job_result")).not.toThrow();
		expect(() => assertWorkerTools([result, web], "submit_job_result", true)).not.toThrow();
		expect(() => assertWorkerTools([], "submit_job_result")).toThrow("received none");
		expect(() =>
			assertWorkerTools(
				[result, { name: "web_fetch", description: "fetch", namespacedName: "builtin:web_fetch" }],
				"submit_job_result",
			)
		).toThrow("builtin:web_fetch");
		expect(() =>
			assertWorkerTools(
				[
					result,
					{ ...web, mcpServerName: "ambient" },
				],
				"submit_job_result",
				true,
			)
		).toThrow("mcp:web_search");
	});

	it("waits for public MCP readiness before auditing the complete tool set", async () => {
		let initializations = 0;
		let polls = 0;
		let now = 0;
		let result = { name: "submit_research_result", description: "submit" };
		let web = {
			name: "web_search",
			description: "search",
			namespacedName: "github-mcp-server/web_search",
			mcpServerName: "github-mcp-server",
			mcpToolName: "web_search",
		};
		let session = {
			rpc: {
				tools: {
					initializeAndValidate: async () => {
						initializations++;
						return {};
					},
					getCurrentMetadata: async () => ({
						tools: initializations > 1 ? [result, web] : [result],
					}),
				},
				mcp: {
					list: async () => ({
						servers: [{
							name: "github-mcp-server",
							status: ++polls > 1 ? "connected" as const : "pending" as const,
						}],
					}),
					listTools: webSearchTools,
				},
			},
		};
		await auditPublicResearchTools(session, "submit_research_result", {
			timeoutMs: 2,
			pollMs: 1,
			now: () => now,
			wait: async ms => {
				now += ms;
			},
		});
		expect(initializations).toBe(2);
		expect(polls).toBe(2);
	});

	it("fails public MCP readiness closed on connection failure and timeout", async () => {
		let metadata = {
			initializeAndValidate: async () => ({}),
			getCurrentMetadata: async () => ({ tools: [] }),
		};
		await expect(auditPublicResearchTools({
			rpc: {
				tools: metadata,
				mcp: {
					list: async () => ({
						servers: [{
							name: "github-mcp-server",
							status: "failed" as const,
							error: "denied",
						}],
					}),
					listTools: webSearchTools,
				},
			},
		}, "submit_research_result")).rejects.toThrow("failed: denied");
		await expect(auditPublicResearchTools({
			rpc: {
				tools: metadata,
				mcp: {
					list: async () => ({
						servers: [{ name: "github-mcp-server", status: "connected" as const }],
					}),
					listTools: async () => ({ tools: [{ name: "get_file" }] }),
				},
			},
		}, "submit_research_result")).rejects.toThrow("does not offer web_search; offered get_file");
		await expect(auditPublicResearchTools({
			rpc: {
				tools: metadata,
				mcp: {
					list: async () => ({
						servers: [{ name: "github-mcp-server", status: "connected" as const }],
					}),
					listTools: webSearchTools,
				},
			},
		}, "submit_research_result")).rejects.toThrow("received none");
		let now = 0;
		await expect(auditPublicResearchTools(
			{
				rpc: {
					tools: metadata,
					mcp: {
						list: async () => ({
							servers: [{ name: "github-mcp-server", status: "pending" as const }],
						}),
						listTools: webSearchTools,
					},
				},
			},
			"submit_research_result",
			{
				timeoutMs: 1,
				pollMs: 1,
				now: () => now,
				wait: async ms => {
					now += ms;
				},
			},
		)).rejects.toThrow("timed out");
		let late = 0;
		await expect(auditPublicResearchTools(
			{
				rpc: {
					tools: metadata,
					mcp: {
						list: async () => {
							late = 2;
							return {
								servers: [{ name: "github-mcp-server", status: "connected" as const }],
							};
						},
						listTools: webSearchTools,
					},
				},
			},
			"submit_research_result",
			{ timeoutMs: 1, now: () => late },
		)).rejects.toThrow("timed out");
		await expect(auditPublicResearchTools(
			{
				rpc: {
					tools: {
						initializeAndValidate: () => new Promise<never>(() => {}),
						getCurrentMetadata: async () => ({ tools: [] }),
					},
					mcp: {
						list: async () => ({ servers: [] }),
						listTools: webSearchTools,
					},
				},
			},
			"submit_research_result",
			{ timeoutMs: 5 },
		)).rejects.toThrow("timed out");
	});

	it("isolates public web research from private capabilities", async () => {
		let result = {
			name: "submit_research_result",
			description: "submit",
			parameters: {},
			handler: () => "ok",
		} as Tool;
		let config = publicResearchConfiguration({ model: "model" }, {
			token: "ghu_owner",
			name: "chopin-public-research",
			prompt: "Research only the disclosed public question.",
			result,
			maxAiCredits: 32,
		});
		expect(config.availableTools).toEqual([
			"custom:submit_research_result",
			"mcp:web_search",
		]);
		expect(config.githubMcpToolConfig).toEqual({ additionalTools: ["web_search"] });
		expect(config.mcpServers).toEqual({});
		expect(config.enableConfigDiscovery).toBe(true);
		expect(config.enableCitations).toBe(true);
		expect(RUNTIME_ENV).toEqual({
			COPILOT_ENABLE_BUILTIN_GITHUB_MCP: "true",
			COPILOT_PLUGIN_DIR_ONLY: "true",
		});
		expect(config.tools).toHaveLength(1);

		let denials = 0;
		let decide = publicResearchGate("submit_research_result", undefined, () => denials++);
		expect(
			await decide({
				kind: "mcp",
				serverName: "github-mcp-server",
				readOnly: true,
				toolName: "web_search",
			} as PermissionRequest, { sessionId: "worker" }),
		).toEqual({ kind: "approve-once" });
		expect(
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "web_search",
			} as PermissionRequest, { sessionId: "worker" }),
		).toMatchObject({ kind: "reject" });
		expect(denials).toBe(1);
		expect(
			await decide({
				kind: "url",
				url: "https://example.com/evidence",
			} as PermissionRequest, { sessionId: "worker" }),
		).toMatchObject({ kind: "reject" });
		expect(
			await decide({
				kind: "custom-tool",
				toolName: "read_plan",
			} as PermissionRequest, { sessionId: "worker" }),
		).toMatchObject({ kind: "reject" });
	});

	it("does not start a worker when the hosted agent is disabled", async () => {
		let result = {
			name: "submit_job_result",
			description: "submit",
			parameters: {},
			handler: () => "ok",
		} as Tool;
		await expect(openWorker(
			{ agent: false, model: "model" },
			{
				token: "ghu_owner",
				name: "chopin-document-summary",
				prompt: "Summarize the supplied document and submit one result.",
				result,
				maxAiCredits: 32,
			},
		)).rejects.toThrow("disabled");
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
			await decide({
				kind: "mcp",
				serverName: "github",
				readOnly: true,
				toolName: "get_pull_request",
				toolTitle: "Pull request",
				args: "octo-org/score",
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
			token: "ghu_owner",
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

	it("resolves authorization again when a repository handler starts", async () => {
		let token: string | undefined = "ghu_current";
		let requests = 0;
		let tools = repositoryTools({
			token: () => token,
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			fetch: async (_input, init) => {
				requests++;
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_current");
				return Response.json({ tree: [], truncated: false });
			},
		});
		let tree = tools.find(tool => tool.name === "list_repository_tree")!;
		expect(await (tree.handler as (raw: unknown) => Promise<string>)({})).not.toContain("Error:");
		token = undefined;
		expect(await (tree.handler as (raw: unknown) => Promise<string>)({})).toContain(
			"authorization expired",
		);
		expect(requests).toBe(1);
	});
});
