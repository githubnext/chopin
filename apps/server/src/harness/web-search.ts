import { createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";

import { requireTools } from "./github-tools";

import type { MCPClientConfig } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { JobExecutionCredential } from "../jobs/registry";
import type { GitHubToolsError, Result } from "./github-tools";

const MCP_URL = "https://api.githubcopilot.com/mcp/";
const WEB_SEARCH_SCHEMA = {
	web_search: { inputSchema: z.object({ query: z.string() }) },
} as const;

type Client = {
	tools(options: { schemas: typeof WEB_SEARCH_SCHEMA }): Promise<ToolSet>;
	close(): Promise<void>;
};

type CreateClient = (config: MCPClientConfig) => Promise<Client>;
type Credential = Extract<JobExecutionCredential, { kind: "active-planner" }>;
const WebContext = z.object({ credential: z.custom<Credential>() });

export async function webSearchTool(
	credential: Credential,
	deps: {
		createClient?: CreateClient;
		onCall?: (result?: unknown, error?: unknown) => void;
	} = {},
): Promise<Result<{ tool: ToolSet["web_search"]; close: () => Promise<void> }, GitHubToolsError>> {
	let client: Client;
	try {
		client = await (deps.createClient ?? (createMCPClient as CreateClient))({
			transport: {
				type: "http",
				url: MCP_URL,
				headers: {
					Authorization: `Bearer ${credential.token}`,
					"X-MCP-Readonly": "true",
					"X-MCP-Toolsets": "web_search",
				},
			},
		});
	} catch (cause) {
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
	try {
		let raw = await client.tools({ schemas: WEB_SEARCH_SCHEMA });
		let picked = requireTools(raw, ["web_search"]);
		if (!picked.ok) {
			await client.close();
			return picked;
		}
		let source = picked.value.web_search!;
		if (!source.execute) throw new Error("MCP web_search has no execution handler");
		let execute = source.execute;
		return {
			ok: true,
			value: {
				tool: tool({
					description: "Search the public web for evidence about the disclosed research query.",
					inputSchema: WEB_SEARCH_SCHEMA.web_search.inputSchema,
					contextSchema: WebContext,
					toModelOutput: source.toModelOutput,
					execute: async (input, options) => {
						let current = (options.context as z.infer<typeof WebContext>).credential;
						if (
							current !== credential || credential.signal?.aborted
							|| credential.expiresAt.getTime() <= Date.now()
							|| !await credential.authorize()
						) throw new Error("MCP web_search authorization ended");
						deps.onCall?.();
						try {
							let result = await execute(input, options);
							if (result && typeof result === "object" && "isError" in result && result.isError) {
								throw new Error("MCP web_search returned an error");
							}
							deps.onCall?.(result);
							return result;
						} catch (error) {
							deps.onCall?.(undefined, error);
							throw error;
						}
					},
				}),
				close: () => client.close(),
			},
		};
	} catch (cause) {
		await client.close().catch(() => {});
		return { ok: false, error: { kind: "Unavailable", cause } };
	}
}
