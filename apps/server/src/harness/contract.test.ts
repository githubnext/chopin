import { harnessContract } from "./contract";
import { tool } from "ai";
import { z } from "zod";

import type { HarnessV1 } from "@ai-sdk/harness";

function fakeHarness(broken = false): HarnessV1 {
	return {
		specificationVersion: "harness-v1",
		harnessId: "fake",
		builtinTools: {
			hidden_builtin: tool({ inputSchema: z.object({}), execute: async () => "unexpected" }),
		},
		supportsBuiltinToolFiltering: true,
		supportsBuiltinToolApprovals: true,
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					let resolve!: () => void;
					let done = new Promise<void>(complete => {
						resolve = complete;
					});
					if (options.prompt === "abort") {
						options.abortSignal?.addEventListener("abort", resolve, { once: true });
					} else if (options.prompt === "output") {
						queueMicrotask(() => {
							options.emit({ type: "text-start", id: "answer" });
							options.emit({
								type: "text-delta",
								id: "answer",
								delta: broken ? '{"answer":5}' : '{"answer":"yes"}',
							});
							options.emit({ type: "text-end", id: "answer" });
							options.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							resolve();
						});
					} else {
						queueMicrotask(() => {
							options.emit({
								type: "tool-call",
								toolCallId: "builtin-1",
								toolName: "hidden_builtin",
								input: "{}",
							});
						});
					}
					return {
						done,
						async submitToolResult(input) {
							if (input.toolCallId === "builtin-1") {
								options.emit({
									type: "tool-call",
									toolCallId: "host-1",
									toolName: "first_host",
									input: "{}",
								});
							} else {
								options.emit({
									type: "finish-step",
									finishReason: { unified: "stop", raw: undefined },
									usage: {
										inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
										outputTokens: { total: 0, text: 0, reasoning: 0 },
									},
								});
								resolve();
							}
						},
					};
				},
				async doDestroy() {},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("not used");
				},
				async doSuspendTurn() {
					throw new Error("not used");
				},
				async doDetach() {
					throw new Error("not used");
				},
				async doStop() {
					throw new Error("not used");
				},
			};
		},
	};
}

harnessContract("fake", () => fakeHarness(process.env.HARNESS_CONTRACT_BROKEN === "1"));
