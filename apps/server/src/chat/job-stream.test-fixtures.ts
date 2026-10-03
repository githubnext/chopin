import type { TextStreamPart, ToolSet } from "ai";
import type { PlannerSession } from "../harness/session";

type Part = TextStreamPart<ToolSet>;

/** Legacy test commands feed the current typed stream, without a Copilot SDK session. */
export function jobStream() {
	let prompts: string[] = [];
	let parts: Part[] = [];
	let wake = Promise.withResolvers<void>();
	let ended = false;
	let error: Error | undefined;
	let aborts = 0;
	function push(part: Part) {
		parts.push(part);
		wake.resolve();
	}
	function end() {
		ended = true;
		wake.resolve();
	}
	function emit(type: string, data: Record<string, unknown> = {}) {
		switch (type) {
			case "assistant.message_delta":
				push({ type: "text-delta", id: String(data.messageId), text: String(data.deltaContent) });
				return;
			case "assistant.message":
				push({ type: "text-end", id: String(data.messageId) });
				return;
			case "tool.execution_start":
				push({
					type: "tool-call",
					toolCallId: String(data.toolCallId),
					toolName: String(data.toolName),
					input: {},
				});
				return;
			case "tool.execution_complete": {
				let content = (data.result as { content?: unknown } | undefined)?.content;
				push(
					data.success
						? {
							type: "tool-result",
							toolCallId: String(data.toolCallId),
							toolName: "refine_decision",
							input: {},
							output: content,
						}
						: {
							type: "tool-error",
							toolCallId: String(data.toolCallId),
							toolName: "refine_decision",
							input: {},
							error: content,
						},
				);
				return;
			}
			case "session.error":
				push({ type: "error", error: new Error(String(data.message)) });
				end();
				return;
			case "session.idle":
				end();
		}
	}
	function session(): PlannerSession {
		return {
			activeTools: ["read_plan", "refine_decision"],
			async stream(prompt, signal) {
				prompts.push(prompt);
				if (error) throw error;
				parts = [];
				ended = false;
				wake = Promise.withResolvers<void>();
				let stop = () => {
					aborts++;
					end();
				};
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
				let fullStream = (async function*() {
					try {
						while (true) {
							while (parts.length) yield parts.shift()!;
							if (ended) return;
							await wake.promise;
							wake = Promise.withResolvers<void>();
						}
					} finally {
						signal.removeEventListener("abort", stop);
					}
				})();
				return { fullStream } as never;
			},
			async destroy() {
				end();
			},
		};
	}
	return {
		prompts,
		emit,
		emitPart: push,
		session,
		aborts: () => aborts,
		setSendError: (value: Error) => error = value,
	};
}
