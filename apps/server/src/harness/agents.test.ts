import { expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import {
	createPlannerAgent,
	createResearchAgent,
	createSummaryAgent,
	descriptionSchema,
	PLANNER_TOOL_NAMES,
} from "./agents";
import { openPlannerSession } from "./session";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { ActiveOwnerBinding } from "../agent/active-owner";

it("opens a host-only Planner turn with bound toolsContext, then destroys its sandbox", async () => {
	let toolsSeen: string[] = [];
	let resultSeen: unknown;
	let destroyed = { session: 0, sandbox: 0 };
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "fake",
		builtinTools: {},
		async doStart(start) {
			expect(start.permissionMode).toBe("allow-reads");
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					toolsSeen = options.tools.map(spec => spec.name);
					expect(options.instructions).toBe("Only Chopin tools");
					let done = Promise.withResolvers<void>();
					queueMicrotask(() =>
						options.emit({
							type: "tool-call",
							toolCallId: "github-1",
							toolName: "list_pull_requests",
							input: "{}",
						})
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							resultSeen = value;
							options.emit({
								type: "tool-result",
								toolCallId: "github-1",
								toolName: "list_pull_requests",
								result: value.output as string,
							});
							options.emit({ type: "text-start", id: "answer" });
							options.emit({ type: "text-delta", id: "answer", delta: "This repository only." });
							options.emit({ type: "text-end", id: "answer" });
							options.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							done.resolve();
						},
					};
				},
				async doDestroy() {
					destroyed.session++;
				},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("unused");
				},
				async doSuspendTurn() {
					throw new Error("unused");
				},
				async doDetach() {
					throw new Error("unused");
				},
				async doStop() {
					throw new Error("unused");
				},
			};
		},
	};
	let owner = {
		channelId: "channel",
		token: "token",
		repository: { id: "R_channel", owner: "githubnext", name: "chopin", defaultBranch: "main" },
		ownerSessionId: "owner-session",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		signal: new AbortController().signal,
		currentToken: () => "token",
		revalidate: async () => true,
		release() {},
	} satisfies ActiveOwnerBinding;
	let opened = await openPlannerSession(owner, {
		room: { id: "channel", plan: {}, server: {} } as never,
		repository: owner.repository,
		instructions: "Only Chopin tools",
	}, {
		agent: createPlannerAgent(fake) as never,
		githubTools: async () => ({
			ok: true,
			value: {
				list_pull_requests: tool({
					inputSchema: z.object({}),
					contextSchema: z.object({ repository: z.object({ id: z.string() }) }),
					execute: async (_input, { context }) => context.repository.id,
				}),
				pull_request_read: tool({ inputSchema: z.object({}), execute: async () => "unused" }),
			},
		}),
		createSandbox: async () =>
			({
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {
					destroyed.sandbox++;
				},
			}) as never,
		registerCredential: () => () => {},
	});
	expect(opened.ok).toBe(true);
	if (!opened.ok) return;
	try {
		let result = await opened.value.stream("read the repository", owner.signal);
		let parts = [];
		for await (let part of result.fullStream) parts.push(part);
		expect(parts.some(part => part.type === "tool-result")).toBe(true);
		expect(parts.some(part => part.type === "text-delta" && part.text === "This repository only."))
			.toBe(true);
		expect(resultSeen).toMatchObject({ output: "R_channel" });
		expect(toolsSeen).toEqual(PLANNER_TOOL_NAMES);
	} finally {
		await opened.value.destroy();
	}
	expect(destroyed).toEqual({ session: 1, sandbox: 1 });
});

it("returns parsed worker output with no built-ins and a per-turn model", async () => {
	let names: string[][] = [];
	let models: (string | undefined)[] = [];
	let formats: unknown[] = [];
	let destroys = 0;
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "worker-fake",
		builtinTools: {},
		async doStart(start) {
			expect(start.builtinToolFiltering).toBeUndefined();
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					names.push(turn.tools.map(spec => spec.name));
					models.push(turn.model);
					formats.push(turn.responseFormat);
					let done = Promise.withResolvers<void>();
					queueMicrotask(() => {
						turn.emit({ type: "text-start", id: "result" });
						turn.emit({
							type: "text-delta",
							id: "result",
							delta: JSON.stringify({ description: "RFC about harnesses" }),
						});
						turn.emit({ type: "text-end", id: "result" });
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						done.resolve();
					});
					return { done: done.promise, async submitToolResult() {}, async submitToolApproval() {} };
				},
				async doDestroy() {
					destroys++;
				},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("unused");
				},
				async doSuspendTurn() {
					throw new Error("unused");
				},
				async doDetach() {
					throw new Error("unused");
				},
				async doStop() {
					throw new Error("unused");
				},
			};
		},
	};
	let agent = createSummaryAgent(fake);
	let session = await agent.createSession({
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			destroy: async () => {},
		} as never,
	});
	try {
		let result = await agent.generate({
			session,
			prompt: "material",
			options: {
				model: "test-model",
				instructions: "describe the document",
			},
		});
		expect(result.output).toEqual({ description: "RFC about harnesses" });
		expect(names).toEqual([[]]);
		expect(models).toEqual(["test-model"]);
		expect(formats).toMatchObject([{ type: "json", schema: { type: "object" } }]);
	} finally {
		await session.destroy();
	}
	expect(destroys).toBe(1);
});

it("research returns parsed public evidence using only per-turn host web_search", async () => {
	let toolNames: string[] = [];
	let seenContext: unknown;
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "research-fake",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					toolNames = turn.tools.map(value => value.name);
					expect(turn.responseFormat).toMatchObject({ type: "json" });
					let done = Promise.withResolvers<void>();
					queueMicrotask(() =>
						turn.emit({
							type: "tool-call",
							toolCallId: "web-1",
							toolName: "web_search",
							input: '{"query":"evidence"}',
						})
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							expect(value.output).toBe("found");
							turn.emit({
								type: "tool-result",
								toolCallId: "web-1",
								toolName: "web_search",
								result: "found",
							});
							turn.emit({ type: "text-start", id: "evidence" });
							turn.emit({
								type: "text-delta",
								id: "evidence",
								delta: JSON.stringify({
									findings: ["Finding"],
									sources: [{ title: "Source", url: "https://example.com/" }],
								}),
							});
							turn.emit({ type: "text-end", id: "evidence" });
							turn.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							done.resolve();
						},
						async submitToolApproval() {},
					};
				},
				async doDestroy() {},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("unused");
				},
				async doSuspendTurn() {
					throw new Error("unused");
				},
				async doDetach() {
					throw new Error("unused");
				},
				async doStop() {
					throw new Error("unused");
				},
			};
		},
	};
	let agent = createResearchAgent(fake);
	let session = await agent.createSession({
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			destroy: async () => {},
		} as never,
	});
	let webSearch = tool({
		inputSchema: z.object({ query: z.string() }),
		contextSchema: z.object({ credential: z.custom<object>() }),
		execute: async (input, options) => {
			seenContext = options.context;
			expect(input).toEqual({ query: "evidence" });
			return "found";
		},
	});
	let credential = { token: "private" };
	try {
		let result = await agent.generate({
			session,
			prompt: "query",
			options: {
				model: "research-model",
				instructions: "web only",
				webSearch,
				webContext: { credential },
			},
		});
		expect(result.output).toEqual({
			findings: ["Finding"],
			sources: [{ title: "Source", url: "https://example.com/" }],
		});
		expect(toolNames).toEqual(["web_search"]);
		expect(seenContext).toEqual({ credential });
	} finally {
		await session.destroy();
	}
});

it("keeps the description's existing Unicode code-point bound after parsing", () => {
	expect(descriptionSchema.safeParse({ description: "😀".repeat(4_000) }).success).toBe(true);
});
