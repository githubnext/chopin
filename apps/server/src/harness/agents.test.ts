import { expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import { createPlannerAgent, PLANNER_TOOL_NAMES } from "./agents";
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
