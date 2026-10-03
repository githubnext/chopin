import type { HarnessV1 } from "@ai-sdk/harness";

/** Drives the current HarnessAgent tool dispatcher, so the real bound heading tool executes. */
export function headingHarness(
	onStart: () => Promise<void>,
	onResult: (output: unknown) => Promise<void>,
	call = {
		name: "draft_heading",
		input: {
			revision: 0,
			title: "Authentication",
			goal: "Choose our authentication approach.",
		} as Record<string, unknown>,
	},
) {
	let finishes: Array<() => void> = [];
	let starts = 0;
	let destroyed = 0;
	let tools: string[][] = [];
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "chat-heading-memory",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					starts++;
					tools.push(options.tools.map(spec => spec.name));
					await onStart();
					let done = Promise.withResolvers<void>();
					let finish = () => {
						options.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						done.resolve();
					};
					finishes.push(finish);
					options.abortSignal?.addEventListener("abort", finish, { once: true });
					void done.promise.then(() => options.abortSignal?.removeEventListener("abort", finish));
					queueMicrotask(() =>
						options.emit({
							type: "tool-call",
							toolCallId: "heading",
							toolName: call.name,
							input: JSON.stringify(call.input),
						})
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							await onResult(value.output);
							options.emit({
								type: "tool-result",
								toolCallId: "heading",
								toolName: call.name,
								result: value.output as string,
							});
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
					for (let finish of finishes) finish();
					return {
						type: "resume-session",
						harnessId: "chat-heading-memory",
						specificationVersion: "harness-v1",
						data: null,
					};
				},
			};
		},
	};
	return {
		fake,
		tools,
		starts: () => starts,
		destroyed: () => destroyed,
		finish: () => finishes.at(-1)?.(),
	};
}
