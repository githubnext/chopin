import type { Harness } from "./types";
import type { RuntimeSource } from "../../apps/server/src/harness/copilot-sdk/runtime";

type Step = { name: string; input: unknown | ((previous: unknown) => unknown) };

/** A scripted adapter tests runner plumbing; its output is never behavioral evaluation evidence. */
export function scriptedHarness(turns: Step[][], text = "Scripted response.") {
	let prompted = 0;
	let destroyed = 0;
	let outputs: unknown[] = [];
	let harness: Harness = {
		specificationVersion: "harness-v1",
		harnessId: "coach-runner-test",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					let steps = turns[prompted++] ?? [];
					let index = 0;
					let done = Promise.withResolvers<void>();
					let advance = (previous?: unknown) => {
						if (turn.abortSignal?.aborted) {
							done.resolve();
							return;
						}
						let step = steps[index++];
						if (step) {
							turn.emit({
								type: "tool-call",
								toolCallId: `call-${index}`,
								toolName: step.name,
								input: JSON.stringify(
									typeof step.input === "function"
										? step.input(previous)
										: step.input,
								),
							});
							return;
						}
						turn.emit({ type: "text-start", id: "answer" });
						turn.emit({ type: "text-delta", id: "answer", delta: text });
						turn.emit({ type: "text-end", id: "answer" });
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						done.resolve();
					};
					turn.abortSignal?.addEventListener("abort", () => done.resolve(), { once: true });
					queueMicrotask(() => advance());
					return {
						done: done.promise,
						async submitToolResult(value) {
							outputs.push(value.output);
							let step = steps[index - 1]!;
							turn.emit({
								type: "tool-result",
								toolCallId: `call-${index}`,
								toolName: step.name,
								result: value.output as string,
							});
							advance(value.output);
						},
					};
				},
				async doDestroy() {
					destroyed++;
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
					return {
						type: "resume-session",
						harnessId: "coach-runner-test",
						specificationVersion: "harness-v1",
						data: {},
					};
				},
			};
		},
	};
	return { harness, outputs, prompted: () => prompted, destroyed: () => destroyed };
}

/** Capture the real Copilot adapter's native configuration without starting a CLI or model. */
export function nativeCopilot() {
	type Config = Parameters<RuntimeSource["client"]["createSession"]>[0];
	let configurations: Config[] = [];
	let prompts: string[] = [];
	let source: RuntimeSource = {
		cleanup() {},
		client: {
			async start() {},
			async stop() {
				return [];
			},
			async forceStop() {},
			async deleteSession() {},
			async createSession(config) {
				configurations.push(config);
				let listeners = new Set<(event: unknown) => void>();
				let emit = (event: unknown) => {
					for (let listener of listeners) listener(event);
				};
				return {
					sessionId: "offline-native-session",
					rpc: {
						tools: {
							async initializeAndValidate() {},
							async getCurrentMetadata() {
								return {
									tools: (config.tools ?? []).map(tool => ({
										name: tool.name,
										namespacedName: `custom:${tool.name}`,
									})),
								};
							},
						},
						mcp: {
							async list() {
								return { servers: [] };
							},
						},
					},
					on(listener: (event: unknown) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async send(input: { prompt: string }) {
						prompts.push(input.prompt);
						emit({
							type: "assistant.message",
							data: {
								messageId: "offline-message",
								content: "Offline transport completed.",
							},
						});
						emit({ type: "session.idle", data: {} });
					},
					async abort() {},
					async disconnect() {},
				} as never;
			},
		},
	};
	return { source, configurations, prompts };
}
