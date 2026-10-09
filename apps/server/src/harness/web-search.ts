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
	web_search: {
		inputSchema: z.object({
			query: z.string().describe(
				"A concise, standalone natural-language question focused on one public topic.",
			),
		}),
	},
} as const;

type Client = {
	tools(options: { schemas: typeof WEB_SEARCH_SCHEMA }): Promise<ToolSet>;
	close(): Promise<void>;
};

type CreateClient = (config: MCPClientConfig) => Promise<Client>;
type Credential = Extract<JobExecutionCredential, { kind: "active-planner" }>;
const WebContext = z.object({ credential: z.custom<Credential>() });

export class WebSearchTimeoutError extends Error {
	constructor(readonly phase: "authorization" | "request" = "request") {
		super(
			phase === "authorization"
				? "MCP web_search authorization timed out"
				: "MCP web_search timed out",
		);
		this.name = "WebSearchTimeoutError";
	}
}

export async function webSearchTool(
	credential: Credential,
	deps: {
		createClient?: CreateClient;
		onCall?: (result?: unknown, error?: unknown) => void | Promise<void>;
		timeoutMs?: number;
	} = {},
): Promise<Result<{ tool: ToolSet["web_search"]; close: () => Promise<void> }, GitHubToolsError>> {
	// The upstream tool runs an AI research agent, so a valid response can take over a minute.
	let timeoutMs = deps.timeoutMs ?? 180_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
		throw new Error("Invalid web search timeout");
	}
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
					description: "Research the public web for evidence about the disclosed research query. "
						+ "An AI research agent answers with citations; each call may take several minutes. "
						+ "Ask one focused natural-language question per call. Split comparisons into separate questions.",
					inputSchema: WEB_SEARCH_SCHEMA.web_search.inputSchema,
					contextSchema: WebContext,
					toModelOutput: source.toModelOutput,
					execute: async (input, options) => {
						let current = (options.context as z.infer<typeof WebContext>).credential;
						if (
							current !== credential || credential.signal?.aborted
							|| credential.expiresAt.getTime() <= Date.now()
						) throw new Error("MCP web_search authorization ended");
						let timeout = AbortSignal.timeout(timeoutMs);
						let signal = AbortSignal.any([
							timeout,
							...(options.abortSignal ? [options.abortSignal] : []),
							...(credential.signal ? [credential.signal] : []),
						]);
						let stop!: () => void;
						let phase: "authorization" | "request" = "authorization";
						let aborted = new Promise<never>((_, reject) => {
							stop = () =>
								reject(
									timeout.aborted
										? new WebSearchTimeoutError(phase)
										: new Error("MCP web_search aborted"),
								);
							if (signal.aborted) stop();
							else signal.addEventListener("abort", stop, { once: true });
						});
						try {
							let result: unknown;
							try {
								result = await Promise.race([
									(async () => {
										signal.throwIfAborted();
										if (!await credential.authorize() || signal.aborted) {
											throw new Error("MCP web_search authorization ended");
										}
										phase = "request";
										await deps.onCall?.();
										signal.throwIfAborted();
										return execute(input, { ...options, abortSignal: signal });
									})(),
									aborted,
								]);
								if (result && typeof result === "object" && "isError" in result && result.isError) {
									throw new Error("MCP web_search returned an error");
								}
							} catch (error) {
								await deps.onCall?.(undefined, error);
								throw error;
							}
							await deps.onCall?.(result);
							return result;
						} finally {
							signal.removeEventListener("abort", stop);
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
