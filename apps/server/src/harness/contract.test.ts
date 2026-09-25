import { harnessContract } from "./contract";
import { tool } from "ai";
import { z } from "zod";

import type { HarnessV1 } from "@ai-sdk/harness";

type FakeVariant =
	| "default"
	| "no-builtins"
	| "approvals-only"
	| "leaky-builtin"
	| "invalid-output"
	| "ignore-abort"
	| "destroy-throws";

function fakeHarness(variant: FakeVariant): HarnessV1 {
	let hostCallId = "call/host:42";
	return {
		specificationVersion: "harness-v1",
		harnessId: "fake",
		builtinTools: variant === "no-builtins" ? {} : {
			hidden_builtin: tool({ inputSchema: z.object({}), execute: async () => "unexpected" }),
		},
		supportsBuiltinToolFiltering: variant !== "approvals-only" && variant !== "no-builtins",
		supportsBuiltinToolApprovals: variant !== "no-builtins",
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
						if (variant !== "ignore-abort") {
							options.abortSignal?.addEventListener("abort", resolve, { once: true });
						}
					} else if (options.prompt === "output") {
						queueMicrotask(() => {
							options.emit({ type: "text-start", id: "answer" });
							options.emit({
								type: "text-delta",
								id: "answer",
								delta: variant === "invalid-output" ? '{"answer":5}' : '{"answer":"yes"}',
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
							if (variant === "leaky-builtin") {
								options.emit({
									type: "tool-call",
									toolCallId: "native-tool",
									toolName: "hidden_builtin",
									input: "{}",
									providerExecuted: true,
								});
								options.emit({
									type: "tool-result",
									toolCallId: "native-tool",
									toolName: "hidden_builtin",
									result: "unexpected",
								});
							}
							options.emit({
								type: "tool-call",
								toolCallId: hostCallId,
								toolName: "first_host",
								input: "{}",
							});
						});
					}
					return {
						done,
						async submitToolResult(input) {
							if (input.toolCallId === hostCallId) {
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
				async doDestroy() {
					if (variant === "destroy-throws") throw new Error("destroy failed");
				},
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

let variant = process.env.HARNESS_CONTRACT_VARIANT as FakeVariant | undefined;
harnessContract("fake", () => fakeHarness(variant ?? "default"));
harnessContract("fake without built-ins", () => fakeHarness("no-builtins"));
