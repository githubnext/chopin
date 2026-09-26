import { expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import { webSearchTool } from "./web-search";

import type { MCPClientConfig } from "@ai-sdk/mcp";
import type { JobExecutionCredential } from "../jobs/registry";

function credential(): Extract<JobExecutionCredential, { kind: "active-planner" }> {
	return {
		kind: "active-planner",
		token: "test-token",
		ownerSessionId: "owner",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		authorize: async () => true,
	};
}

it("loads only the host GitHub MCP web_search and binds execution to the owner", async () => {
	let config: MCPClientConfig | undefined;
	let names: string[] = [];
	let closed = 0;
	let calls: unknown[] = [];
	let owner = credential();
	let result = await webSearchTool(owner, {
		createClient: async value => {
			config = value;
			return {
				async tools({ schemas }) {
					names = Object.keys(schemas);
					return {
						web_search: tool({
							inputSchema: z.object({ query: z.string() }),
							execute: async input => ({
								content: [{ type: "text", text: JSON.stringify(input) }],
							}),
						}),
					};
				},
				async close() {
					closed++;
				},
			};
		},
		onCall: (value, error) => calls.push({ value, error }),
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(config?.transport).toMatchObject({
		type: "http",
		url: "https://api.githubcopilot.com/mcp/",
		headers: {
			Authorization: "Bearer test-token",
			"X-MCP-Readonly": "true",
			"X-MCP-Toolsets": "web_search",
		},
	});
	expect(names).toEqual(["web_search"]);
	expect(result.value.tool.description).toContain("disclosed research query");
	let output = await result.value.tool.execute!(
		{ query: "query" },
		{ context: { credential: owner } } as never,
	);
	expect(output).toEqual({ content: [{ type: "text", text: '{"query":"query"}' }] });
	expect(calls).toHaveLength(2);
	await expect(result.value.tool.execute!({ query: "query" }, {
		context: { credential: credential() },
	} as never)).rejects.toThrow("authorization ended");
	await result.value.close();
	expect(closed).toBe(1);
});

it("fails closed when MCP does not offer web_search or connection fails", async () => {
	let closed = 0;
	let missing = await webSearchTool(credential(), {
		createClient: async () => ({
			tools: async () => ({}),
			close: async () => {
				closed++;
			},
		}),
	});
	expect(missing).toEqual({ ok: false, error: { kind: "MissingTool", name: "web_search" } });
	expect(closed).toBe(1);
	let unavailable = await webSearchTool(credential(), {
		createClient: async () => {
			throw new Error("offline");
		},
	});
	expect(unavailable).toMatchObject({ ok: false, error: { kind: "Unavailable" } });
});

it("does not count a resolved MCP error as a successful search", async () => {
	let results: unknown[] = [];
	let owner = credential();
	let loaded = await webSearchTool(owner, {
		createClient: async () => ({
			tools: async () => ({
				web_search: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }),
				}),
			}),
			close: async () => {},
		}),
		onCall: (result, error) => results.push({ result, error }),
	});
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) return;
	try {
		await expect(loaded.value.tool.execute!({ query: "query" }, {
			context: { credential: owner },
		} as never)).rejects.toThrow("MCP web_search returned an error");
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ result: undefined, error: undefined });
		expect(results[1]).toMatchObject({ error: expect.any(Error) });
	} finally {
		await loaded.value.close();
	}
});
