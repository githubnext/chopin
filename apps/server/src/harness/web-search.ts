import { createMCPClient, MCPClientError } from "@ai-sdk/mcp";
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

export type WebSearchFailureDiagnostic = {
	webFailure: string;
	webFailureDurationMs: number;
	webFailureToolCallId?: string;
};

/** Calls one evidence attempt may start; the upstream tool takes about two minutes each. */
export const WEB_SEARCH_MAX_CALLS = 4;
/** Below this much remaining attempt time a new call cannot finish usefully. */
export const WEB_SEARCH_MIN_WINDOW_MS = 90_000;
/** Time kept after the last call returns so the model can still submit its result. */
export const WEB_SEARCH_MARGIN_MS = 30_000;
const MAX_REASON = 300;

export type WebSearchBudget = {
	deadline: Date;
	maxCalls?: number;
	minWindowMs?: number;
	marginMs?: number;
};

/**
 * Upstream error text bounded for logs and diagnostics. Credentials, auth headers, URL queries and
 * long opaque strings are removed before the text is cut, so a secret is never split by the cut.
 */
export function sanitizeUpstream(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (let secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
	out = Array.from(
		out,
		char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char),
	)
		.join("")
		.replace(
			/\b(authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*[:=]\s*.*/gi,
			"$1: [redacted]",
		)
		.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted]")
		.replace(
			/\b(token|secret|password|passwd|api[_-]?key|access[_-]?token)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
			"$1$2[redacted]",
		)
		.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, "$1?[redacted]")
		.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON - 1)}…` : out;
}

/** An upstream web_search result that reported an error. `detail` is already sanitized. */
export class WebSearchError extends Error {
	constructor(readonly detail: string) {
		super("MCP web_search returned an error");
		this.name = "WebSearchError";
	}
}

function resultText(result: object): string {
	let content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content.map(block =>
		block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
			? (block as { text: string }).text
			: ""
	).join(" ");
}

function refusal(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

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
		onCall?: (
			result?: unknown,
			error?: unknown,
			diagnostic?: WebSearchFailureDiagnostic,
		) => void | Promise<void>;
		/** A call refused before dispatch, because the call cap or the remaining time is spent. */
		onRefused?: (reason: "calls" | "time") => void;
		timeoutMs?: number;
		/** Budgets calls against the attempt deadline; unset, calls are unbudgeted. */
		budget?: WebSearchBudget;
		now?: () => number;
		log?: (line: string) => void;
	} = {},
): Promise<Result<{ tool: ToolSet["web_search"]; close: () => Promise<void> }, GitHubToolsError>> {
	// The upstream tool runs an AI research agent, so a valid response can take over a minute.
	let timeoutMs = deps.timeoutMs ?? 180_000;
	let now = deps.now ?? Date.now;
	let log = deps.log ?? ((line: string) => console.warn(line));
	let started = 0;
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
						let callTimeoutMs = timeoutMs;
						if (deps.budget) {
							let { maxCalls = WEB_SEARCH_MAX_CALLS, marginMs = WEB_SEARCH_MARGIN_MS } =
								deps.budget;
							let { minWindowMs = WEB_SEARCH_MIN_WINDOW_MS } = deps.budget;
							let remaining = deps.budget.deadline.getTime() - now();
							if (started >= maxCalls) {
								deps.onRefused?.("calls");
								return refusal(
									`web_search call limit reached (${maxCalls} per attempt). `
										+ "Do not search again; submit your result now from the sources already returned.",
								);
							}
							if (remaining < minWindowMs) {
								deps.onRefused?.("time");
								return refusal(
									"Not enough time remains for another web_search call. "
										+ "Do not search again; submit your result now from the sources already returned.",
								);
							}
							callTimeoutMs = Math.min(timeoutMs, remaining - marginMs);
						}
						started++;
						let began = performance.now();
						let resultError = false;
						let timeout = AbortSignal.timeout(callTimeoutMs);
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
									resultError = true;
									throw new WebSearchError(
										sanitizeUpstream(resultText(result), [credential.token]),
									);
								}
							} catch (error) {
								// Only known classifications and numeric MCP codes cross into job logs.
								let kind = timeout.aborted
									? "timeout"
									: signal.aborted
									? "aborted"
									: resultError
									? "mcp-result-error"
									: MCPClientError.isInstance(error)
									? "mcp-client"
									: error instanceof Error
									? "error"
									: "unknown";
								let diagnostic: WebSearchFailureDiagnostic = {
									webFailure: `local:${phase}:${kind}`,
									webFailureDurationMs: Math.round(performance.now() - began),
								};
								if (MCPClientError.isInstance(error)) {
									if (Number.isSafeInteger(error.code)) {
										diagnostic.webFailure += `:rpc:${error.code}`;
									}
									if (
										Number.isSafeInteger(error.statusCode) && error.statusCode! >= 100
										&& error.statusCode! <= 599
									) {
										diagnostic.webFailure += `:http:${error.statusCode}`;
									}
								}
								if (
									/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
										options.toolCallId,
									)
								) {
									diagnostic.webFailureToolCallId = options.toolCallId;
								}
								if (!(error instanceof WebSearchTimeoutError)) {
									let detail = error instanceof WebSearchError
										? error.detail
										: error instanceof Error
										? sanitizeUpstream(error.message, [credential.token])
										: "";
									log(`chopin: web_search failed - ${detail || "no error text"}`);
								}
								await deps.onCall?.(undefined, error, diagnostic);
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
