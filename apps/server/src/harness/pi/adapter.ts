/**
 * Wraps `@ai-sdk/harness-pi`'s `createPi()` to support Chopin's structured
 * `output`, which the published adapter rejects outright
 * (`HarnessCapabilityUnsupportedError` on any `responseFormat.type === "json"`
 * turn). Every other turn, and every session/built-in/abort/destroy
 * guarantee, passes straight through to the real Pi harness unchanged.
 *
 * The approach mirrors the Copilot SDK adapter's internal result tool: Pi
 * already runs host tools (`buildUserToolDefinition`) without turning on a
 * built-in, so a synthetic host tool that captures the model's final answer
 * gets Pi to a structured result without Pi ever seeing `responseFormat`.
 */

import { createPi } from "@ai-sdk/harness-pi";

import type {
	HarnessV1,
	HarnessV1ContinueTurnOptions,
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StreamPart,
	HarnessV1ToolSpec,
} from "@ai-sdk/harness";
import type { PiHarnessSettings } from "@ai-sdk/harness-pi";

export const PI_RESULT_TOOL_NAME = "chopin_submit_pi_result";

const ZERO_USAGE = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

const RESULT_INSTRUCTION =
	`When you have the final answer for this turn, call the ${PI_RESULT_TOOL_NAME} tool exactly once `
	+ "with the required fields instead of replying in plain text.";

type OutputTurn = HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions;

/** Runs one turn through Pi, translating a requested JSON `responseFormat`
 * into a synthetic result tool. Non-JSON turns pass through unchanged. */
async function runOutputTurn<T extends OutputTurn>(
	run: (options: T) => PromiseLike<HarnessV1PromptControl>,
	turn: T,
): Promise<HarnessV1PromptControl> {
	if (turn.tools.some(spec => spec.name === PI_RESULT_TOOL_NAME)) {
		throw new Error(`Host tool name ${PI_RESULT_TOOL_NAME} is reserved for structured output.`);
	}
	let responseFormat = turn.responseFormat;
	if (responseFormat?.type !== "json") return run(turn);

	let received: { value: unknown } | undefined;
	let parseError: Error | undefined;
	let suppressedIds = new Set<string>();
	let control: HarnessV1PromptControl | undefined;
	let controlReady = Promise.withResolvers<void>();

	let wrappedEmit = (part: HarnessV1StreamPart) => {
		switch (part.type) {
			case "tool-input-start":
				if (part.toolName === PI_RESULT_TOOL_NAME) {
					suppressedIds.add(part.id);
					return;
				}
				break;
			case "tool-input-delta":
			case "tool-input-end":
				if (suppressedIds.has(part.id)) {
					if (part.type === "tool-input-end") suppressedIds.delete(part.id);
					return;
				}
				break;
			case "tool-call":
				if (part.toolName === PI_RESULT_TOOL_NAME) {
					let toolCallId = part.toolCallId;
					try {
						received = { value: JSON.parse(part.input || "{}") };
					} catch (cause) {
						parseError = new Error("Pi returned an invalid structured result.", { cause });
					}
					let submit = () =>
						controlReady.promise
							.then(() => control!.submitToolResult({ toolCallId, output: "Result received." }))
							.catch(submitCause => turn.emit({ type: "error", error: submitCause }));
					// Pi's own agent loop can report the tool call before its internal
					// execution registers the pending result to resolve, so submit on
					// the next macrotask rather than racing it on a microtask.
					setTimeout(submit, 0);
					return;
				}
				break;
			case "tool-result":
				if (part.toolName === PI_RESULT_TOOL_NAME) return;
				break;
			case "finish-step":
				// Pi's own step boundaries are dropped; one synthetic finish-step
				// follows the recorded result on the turn's terminal "finish".
				return;
			case "text-start":
			case "text-delta":
			case "text-end":
			case "reasoning-start":
			case "reasoning-delta":
			case "reasoning-end":
				return; // Ordinary prose or reasoning is not the model's structured answer.
			case "finish":
				if (received) {
					let id = crypto.randomUUID();
					turn.emit({ type: "text-start", id });
					turn.emit({ type: "text-delta", id, delta: JSON.stringify(received.value) });
					turn.emit({ type: "text-end", id });
					turn.emit({
						type: "finish-step",
						finishReason: { unified: "stop", raw: undefined },
						usage: ZERO_USAGE,
					});
				}
				break; // Forward the terminal finish; `done` rejects below without a result.
		}
		turn.emit(part);
	};

	let resultSpec: HarnessV1ToolSpec = {
		name: PI_RESULT_TOOL_NAME,
		description: responseFormat.description
			?? "Submit the final structured result for this turn.",
		inputSchema: responseFormat.schema as HarnessV1ToolSpec["inputSchema"],
	};
	control = await run({
		...turn,
		responseFormat: undefined,
		tools: [...turn.tools, resultSpec],
		instructions: [turn.instructions, RESULT_INSTRUCTION].filter(Boolean).join("\n\n"),
		emit: wrappedEmit,
	} as T);
	controlReady.resolve();

	return {
		submitToolResult: input => control!.submitToolResult(input),
		submitToolApproval: input => control!.submitToolApproval?.(input) ?? Promise.resolve(),
		submitUserMessage: text => control!.submitUserMessage?.(text) ?? Promise.resolve(),
		done: control.done.then(() => {
			if (parseError) throw parseError;
			if (!received) throw new Error("Pi turn ended without a structured result.");
		}),
	};
}

export function wrapSession(inner: HarnessV1Session): HarnessV1Session {
	return {
		...inner,
		doPromptTurn: turn => runOutputTurn(options => inner.doPromptTurn(options), turn),
		doContinueTurn: turn => runOutputTurn(options => inner.doContinueTurn(options), turn),
	};
}

export function createPiAdapter(
	settings?: PiHarnessSettings,
): HarnessV1 & { shutdown(): Promise<void> } {
	let pi = createPi(settings);
	return {
		...pi,
		async doStart(startOptions) {
			let session = await pi.doStart(startOptions);
			return wrapSession(session);
		},
		async shutdown() {},
	};
}
