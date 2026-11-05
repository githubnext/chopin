import { expect, it, spyOn } from "bun:test";
import { tool } from "ai";
import { MCPClientError } from "@ai-sdk/mcp";
import { z } from "zod";

import {
	WEB_SEARCH_MARGIN_MS,
	WEB_SEARCH_MAX_CALLS,
	WebSearchTimeoutError,
	webSearchTool,
} from "./web-search";

import { executionDiagnostic } from "../jobs/registry";

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
		onCall: (value, error) => {
			calls.push({ value, error });
		},
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
		log: () => {},
		createClient: async () => ({
			tools: async () => ({}),
			close: async () => {
				closed++;
			},
		}),
	});
	expect(missing).toMatchObject({ ok: false, error: { kind: "MissingTool", name: "web_search" } });
	expect(closed).toBe(1);
	let unavailable = await webSearchTool(credential(), {
		log: () => {},
		createClient: async () => {
			throw new Error("offline");
		},
	});
	expect(unavailable).toMatchObject({ ok: false, error: { kind: "Unavailable" } });
});

it("names a credential the endpoint refuses at connect, with its type and a redacted message", async () => {
	let secret = "ghu_abcdefghijklmnopqrstuvwxyz0123456789";
	let logs: string[] = [];
	let result = await webSearchTool({ ...credential(), token: secret }, {
		log: line => logs.push(line),
		createClient: async () => {
			throw new MCPClientError({
				message: "MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): "
					+ `unauthorized: token authentication failed for Bearer ${secret}`,
				statusCode: 401,
				url: "https://api.githubcopilot.com/mcp/",
			});
		},
	});
	expect(result).toMatchObject({
		ok: false,
		error: {
			kind: "Unavailable",
			failure: {
				reason: "web-search-credential-rejected",
				classification: "local:connect:mcp-client:http:401",
				durationMs: expect.any(Number),
			},
		},
	});
	expect(logs).toHaveLength(1);
	expect(logs[0]).toStartWith("chopin: web_search unavailable at connect - ");
	expect(logs[0]).toContain("local:connect:mcp-client:http:401");
	expect(logs[0]).toContain("GitHub App user access token (ghu_)");
	expect(logs[0]).toContain("unauthorized: token authentication failed");
	expect(logs[0]).not.toContain(secret);
	expect(logs[0]).not.toContain("abcdefghijkl");
	expect(logs[0]).not.toContain("\n");
});

it("reads a refusal while listing tools as the same rejected credential", async () => {
	let logs: string[] = [];
	let closed = 0;
	let result = await webSearchTool({ ...credential(), token: "gho_0123456789abcdefghijklmnop" }, {
		log: line => logs.push(line),
		createClient: async () => ({
			tools: async () => {
				throw new MCPClientError({
					message: "MCP HTTP Transport Error: POSTing to endpoint (HTTP 403): forbidden",
					statusCode: 403,
					code: -32001,
				});
			},
			close: async () => {
				closed++;
			},
		}),
	});
	expect(result).toMatchObject({
		ok: false,
		error: {
			failure: {
				reason: "web-search-credential-rejected",
				classification: "local:tools:mcp-client:rpc:-32001:http:403",
			},
		},
	});
	expect(closed).toBe(1);
	expect(logs).toHaveLength(1);
	expect(logs[0]).toStartWith("chopin: web_search unavailable at tools - ");
	expect(logs[0]).toContain("OAuth app access token (gho_)");
});

it("reports a connection that is accepted without web_search as not offered", async () => {
	let logs: string[] = [];
	let result = await webSearchTool({
		...credential(),
		token: "ghu_abcdefghijklmnopqrstuvwxyz0123456789",
	}, {
		log: line => logs.push(line),
		createClient: async () => ({
			tools: async () => ({
				list_pull_requests: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
			}),
			close: async () => {},
		}),
	});
	expect(result).toMatchObject({
		ok: false,
		error: {
			kind: "MissingTool",
			name: "web_search",
			failure: {
				reason: "web-search-not-offered",
				classification: "local:tools:missing-tool",
			},
		},
	});
	expect(logs).toEqual([
		expect.stringMatching(
			/^chopin: web_search unavailable at tools - local:tools:missing-tool in \d+ms; credential: GitHub App user access token \(ghu_\); the endpoint answered but did not offer web_search; see Troubleshooting in docs\/self-hosting\.md$/,
		),
	]);
});

it("keeps other setup failures unavailable and says what kind of token was used", async () => {
	let logs: string[] = [];
	for (
		let cause of [
			new MCPClientError({ message: "bad gateway", statusCode: 502 }),
			new MCPClientError({ message: "no such method", code: -32601 }),
			Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
			"TLS handshake failed for opaque-token-value",
		]
	) {
		let result = await webSearchTool({ ...credential(), token: "opaque-token-value" }, {
			log: line => logs.push(line),
			createClient: async () => {
				throw cause;
			},
		});
		expect(result).toMatchObject({
			ok: false,
			error: { failure: { reason: "web-search-unavailable" } },
		});
		if (result.ok) throw new Error("fixture failed");
		expect(executionDiagnostic({ webFailure: result.error.failure.classification }))
			.toBeDefined();
	}
	expect(logs.map(line => /- (\S+) in /.exec(line)?.[1])).toEqual([
		"local:connect:mcp-client:http:502",
		"local:connect:mcp-client:rpc:-32601",
		"local:connect:error",
		"local:connect:unknown",
	]);
	for (let line of logs) {
		expect(line).toContain("credential: token of an unrecognized type");
		expect(line).not.toContain("Troubleshooting");
	}
	expect(logs[3]).toContain("thrown string: TLS handshake failed for [redacted]");
	expect(logs[3]).not.toContain("opaque-token-value");
});

it("masks credentials and clips a setup failure before it is logged", async () => {
	let secret = "opaque-credential-value";
	let message = [
		`MCP HTTP Transport Error: POSTing to endpoint (HTTP 401): rejected echo ${secret}`,
		`Authorization: Bearer ${secret}`,
		"retry with github_pat_11ABCDEFG0123456789_abcdefghijklmnop or ghs_abcdefghijklmnopqrstuvwxyz0123456789",
		`\u001b[31mcolour\u001b[0m ${secret} ${"x".repeat(900)}`,
	].join("\n");
	for (let name of [`Bearer ${secret}`, "ghu_abcdefghijklmnopqrstuvwxyz0123456789"]) {
		let logs: string[] = [];
		await webSearchTool({ ...credential(), token: secret }, {
			log: line => logs.push(line),
			createClient: async () => {
				throw Object.assign(new MCPClientError({ message, statusCode: 401 }), { name });
			},
		});
		expect(logs).toHaveLength(1);
		let line = logs[0]!;
		expect(line).not.toContain(secret);
		expect(line).not.toContain("github_pat_");
		expect(line).not.toContain("ghs_");
		expect(line).not.toContain("ghu_abcdefghijkl");
		expect(line).not.toContain("abcdefghijkl");
		expect(line).not.toMatch(/\p{Cc}/u);
		expect(line).toContain(
			"rejected echo [redacted] Authorization: Bearer [redacted] retry with [redacted] or [redacted]",
		);
		expect(line).toMatch(/; (?:Error|\[redacted\]): MCP HTTP Transport Error: POSTing/);
		expect(line.length).toBeLessThan(500);
	}
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
		onCall: (result, error) => {
			results.push({ result, error });
		},
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

it("accepts a cited search response that takes longer than one minute", async () => {
	let timers: Array<{ duration: number; controller: AbortController }> = [];
	let timeout = spyOn(AbortSignal, "timeout").mockImplementation(duration => {
		let controller = new AbortController();
		timers.push({ duration, controller });
		return controller.signal;
	});
	let owner = { ...credential(), expiresAt: new Date(Date.now() + 300_000) };
	let response = {
		content: [{
			type: "text",
			text: JSON.stringify({
				text: {
					value: "Evidence",
					annotations: [{
						url_citation: { url: "https://www.notion.com/help/updates-and-notifications" },
					}],
				},
			}),
		}],
	};
	let loaded: Awaited<ReturnType<typeof webSearchTool>> | undefined;
	try {
		loaded = await webSearchTool(owner, {
			createClient: async () => ({
				tools: async () => ({
					web_search: tool({
						inputSchema: z.object({ query: z.string() }),
						execute: async (_input, options) => {
							for (let { duration, controller } of timers) {
								if (duration <= 90_000) controller.abort();
							}
							options.abortSignal?.throwIfAborted();
							return response;
						},
					}),
				}),
				close: async () => {},
			}),
		});
		if (!loaded.ok) throw new Error("fixture failed");
		expect(
			await loaded.value.tool.execute!({ query: "notification design" }, {
				context: { credential: owner },
			} as never),
		).toEqual(response);
	} finally {
		timeout.mockRestore();
		if (loaded?.ok) await loaded.value.close();
	}
});

it("times out a stalled search, aborts its request, and ignores late output", async () => {
	let owner = credential();
	let pending = Promise.withResolvers<unknown>();
	let signal: AbortSignal | undefined;
	let calls: Array<{ result?: unknown; error?: unknown }> = [];
	let loaded = await webSearchTool(owner, {
		timeoutMs: 20,
		createClient: async () => ({
			tools: async () => ({
				web_search: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async (_input, options) => {
						signal = options.abortSignal;
						return pending.promise;
					},
				}),
			}),
			close: async () => {},
		}),
		onCall: (result, error) => {
			calls.push({ result, error });
		},
	});
	if (!loaded.ok) throw new Error("fixture failed");
	try {
		await expect(
			loaded.value.tool.execute!(
				{ query: "synthetic" },
				{ context: { credential: owner } } as never,
			),
		).rejects.toBeInstanceOf(WebSearchTimeoutError);
		expect(signal?.aborted).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.error).toBeInstanceOf(WebSearchTimeoutError);
		expect(calls[1]?.error).toMatchObject({ phase: "request" });
		pending.resolve({ content: [] });
		await Promise.resolve();
		expect(calls).toHaveLength(2);
	} finally {
		pending.resolve({});
		await loaded.value.close();
	}
});

it("a timed-out authorization cannot start a search after it finally resolves", async () => {
	let authorization = Promise.withResolvers<boolean>();
	let owner = { ...credential(), authorize: () => authorization.promise };
	let calls = 0;
	let events: Array<{ result?: unknown; error?: unknown }> = [];
	let loaded = await webSearchTool(owner, {
		timeoutMs: 20,
		onCall: (result, error) => {
			events.push({ result, error });
		},
		createClient: async () => ({
			tools: async () => ({
				web_search: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => {
						calls++;
						return {};
					},
				}),
			}),
			close: async () => {},
		}),
	});
	if (!loaded.ok) throw new Error("fixture failed");
	try {
		await expect(
			loaded.value.tool.execute!(
				{ query: "synthetic" },
				{ context: { credential: owner } } as never,
			),
		).rejects.toMatchObject({ name: "WebSearchTimeoutError", phase: "authorization" });
		expect(events).toHaveLength(1);
		expect(events[0]?.error).toMatchObject({ phase: "authorization" });
		authorization.resolve(true);
		await Promise.resolve();
		expect(calls).toBe(0);
	} finally {
		authorization.resolve(false);
		await loaded.value.close();
	}
});

for (
	let scenario of ["rpc", "response", "error", "unknown", "cancel", "timeout", "success"] as const
) {
	it(`records sanitized web-search failure metadata for ${scenario}`, async () => {
		let sensitive = "private query https://private.example/result Bearer secret-token";
		let controller = new AbortController();
		let owner = credential();
		let diagnostics: unknown[] = [];
		let rpc = new MCPClientError({
			name: sensitive,
			message: sensitive,
			code: -32603,
			statusCode: 502,
			url: "https://private.example/result",
			responseBody: sensitive,
			data: { token: sensitive },
		});
		let loaded = await webSearchTool(owner, {
			timeoutMs: 10,
			onCall: (_result, _error, diagnostic) => {
				if (diagnostic) diagnostics.push(diagnostic);
			},
			createClient: async () => ({
				tools: async () => ({
					web_search: tool({
						inputSchema: z.object({ query: z.string() }),
						execute: async () => {
							if (scenario === "rpc") throw rpc;
							if (scenario === "error") {
								throw Object.assign(new Error(sensitive), { name: sensitive });
							}
							if (scenario === "unknown") throw { code: sensitive, name: sensitive };
							if (scenario === "cancel") controller.abort(new Error(sensitive));
							if (scenario === "cancel" || scenario === "timeout") {
								return new Promise(() => {});
							}
							return {
								isError: scenario === "response",
								content: [{ type: "text", text: sensitive }],
							};
						},
					}),
				}),
				close: async () => {},
			}),
		});
		if (!loaded.ok) throw new Error("fixture failed");
		try {
			let call = loaded.value.tool.execute!({ query: sensitive }, {
				context: { credential: owner },
				toolCallId: scenario === "unknown" ? sensitive : "d9dc5586-b81f-442c-b9e1-feb5d186f334",
				abortSignal: controller.signal,
			} as never);
			if (scenario === "success") {
				await call;
				expect(diagnostics).toEqual([]);
				return;
			}
			await expect(Promise.resolve(call)).rejects.toBeDefined();
			let kinds = {
				rpc: "mcp-client",
				error: "error",
				response: "mcp-result-error",
				unknown: "unknown",
				cancel: "aborted",
				timeout: "timeout",
			};
			expect(diagnostics).toEqual([{
				webFailure: `local:request:${kinds[scenario]}${
					scenario === "rpc" ? ":rpc:-32603:http:502" : ""
				}`,
				webFailureDurationMs: expect.any(Number),
				...(scenario === "unknown"
					? {}
					: { webFailureToolCallId: "d9dc5586-b81f-442c-b9e1-feb5d186f334" }),
			}]);
			expect(() =>
				executionDiagnostic({
					stage: "public-web",
					phase: "waiting-web-search",
					webCalls: 1,
					webSuccesses: 0,
					webFailures: 1,
					hostedCalls: 0,
					hostedCompleted: 0,
					citableSources: 0,
					outputSources: 0,
					resultSubmitted: false,
					resultInvalid: false,
					webSearchDenied: false,
					elapsedMs: 100,
					...diagnostics[0] as Record<string, string | number>,
				})
			).not.toThrow();
			expect(JSON.stringify(diagnostics)).not.toContain(sensitive);
			expect(JSON.stringify(diagnostics)).not.toContain("private.example");
		} finally {
			await loaded.value.close();
		}
	});
}

const OK = { content: [{ type: "text", text: "ok" }] };

async function budgeted(
	deadlineIn: number,
	extra: Partial<NonNullable<Parameters<typeof webSearchTool>[1]>> = {},
	execute: () => Promise<unknown> = async () => OK,
) {
	let owner = { ...credential(), expiresAt: new Date(Date.now() + 3_600_000) };
	let at = 1_000_000;
	let dispatched = 0;
	let refused: string[] = [];
	let loaded = await webSearchTool(owner, {
		now: () => at,
		budget: { deadline: new Date(at + deadlineIn) },
		onRefused: reason => refused.push(reason),
		log: () => {},
		createClient: async () => ({
			tools: async () => ({
				web_search: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => {
						dispatched++;
						return execute();
					},
				}),
			}),
			close: async () => {},
		}),
		...extra,
	});
	if (!loaded.ok) throw new Error("fixture failed");
	let run = () =>
		loaded.value.tool.execute!({ query: "q" }, { context: { credential: owner } } as never);
	return { run, dispatched: () => dispatched, refused, close: loaded.value.close };
}

it("refuses a call, without dispatching it, when too little time remains", async () => {
	let search = await budgeted(60_000);
	try {
		let result = await search.run();
		expect(JSON.stringify(result)).toContain("submit your result now");
		expect(search.dispatched()).toBe(0);
		expect(search.refused).toEqual(["time"]);
	} finally {
		await search.close();
	}
});

it("clamps each call's timeout to the remaining time minus the margin", async () => {
	let timers: number[] = [];
	let spy = spyOn(AbortSignal, "timeout").mockImplementation(duration => {
		timers.push(duration);
		return new AbortController().signal;
	});
	let search = await budgeted(150_000);
	try {
		await search.run();
		expect(timers).toEqual([150_000 - WEB_SEARCH_MARGIN_MS]);
		let roomy = await budgeted(600_000);
		await roomy.run();
		expect(timers[1]).toBe(180_000);
		await roomy.close();
	} finally {
		spy.mockRestore();
		await search.close();
	}
});

it("caps the calls one attempt may start, counting calls still in flight", async () => {
	let pending = Promise.withResolvers<unknown>();
	let search = await budgeted(600_000, {}, () => pending.promise);
	try {
		let started = Array.from({ length: WEB_SEARCH_MAX_CALLS }, () => search.run());
		let extra = await search.run();
		expect(JSON.stringify(extra)).toContain("call limit reached");
		expect(search.refused).toEqual(["calls"]);
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(search.dispatched()).toBe(WEB_SEARCH_MAX_CALLS);
		pending.resolve(OK);
		await Promise.all(started);
	} finally {
		await search.close();
	}
});

it("logs only the failure classification, never upstream text or the token", async () => {
	let secret = "ghu_abcdefghijklmnopqrstuvwxyz0123456789";
	let owner = { ...credential(), token: secret };
	let logs: string[] = [];
	let loaded = await webSearchTool(owner, {
		log: line => logs.push(line),
		createClient: async () => ({
			tools: async () => ({
				web_search: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => ({
						isError: true,
						content: [{
							type: "text",
							text: `HTTP 429 rate limited. Authorization: Bearer ${secret} retry ${
								"x".repeat(900)
							}`,
						}],
					}),
				}),
			}),
			close: async () => {},
		}),
	});
	if (!loaded.ok) throw new Error("fixture failed");
	try {
		await expect(
			loaded.value.tool.execute!({ query: "q" }, { context: { credential: owner } } as never),
		).rejects.toThrow("MCP web_search returned an error");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toBe("chopin: web_search failed - local:request:mcp-result-error");
	} finally {
		await loaded.value.close();
	}
});
