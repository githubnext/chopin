/**
 * Wraps `@ai-sdk/harness-pi`'s `createPi()` to support Chopin's structured
 * `output`, which the published adapter rejects outright
 * (`HarnessCapabilityUnsupportedError` on any `responseFormat.type === "json"`
 * turn). Every other turn, and every session/built-in/abort/destroy
 * guarantee, passes straight through to the real Pi harness unchanged.
 *
 * The result tool is a Pi extension tool, following Pi's structured-output
 * example: it runs inside Pi's own agent loop and returns `terminate: true`,
 * so the turn ends on that call without a host round trip or a follow-up
 * model request. The extension offers the tool only on turns whose
 * instructions ask for a structured result and blocks it on every other turn.
 */

import { createPi } from "@ai-sdk/harness-pi";
import { Type } from "typebox";

import type {
	HarnessV1,
	HarnessV1ContinueTurnOptions,
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type { PiHarnessSettings } from "@ai-sdk/harness-pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PI_RESULT_TOOL_NAME = "chopin_submit_pi_result";

export const PI_RESULT_INSTRUCTION =
	`When you have the final answer for this turn, call the ${PI_RESULT_TOOL_NAME} tool exactly once `
	+ "with the required fields instead of replying in plain text.";

const ZERO_USAGE = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/**
 * Registers the terminating result tool in each Pi session. Pi runs this
 * factory once per session with that session's API, so the structured flag
 * is per session. `before_agent_start` sees the fully assembled system
 * prompt, which carries `PI_RESULT_INSTRUCTION` only on structured turns.
 */
export function piResultToolExtension(pi: ExtensionAPI): void {
	let structured = false;
	pi.registerTool({
		name: PI_RESULT_TOOL_NAME,
		label: "Submit result",
		description: "Submit the final structured result for this turn.",
		parameters: Type.Object({}, { additionalProperties: true }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Result received." }],
				details: params,
				terminate: true,
			};
		},
	});
	pi.on("before_agent_start", event => {
		structured = event.systemPrompt.includes(PI_RESULT_INSTRUCTION);
		let others = pi.getActiveTools().filter(name => name !== PI_RESULT_TOOL_NAME);
		pi.setActiveTools(structured ? [...others, PI_RESULT_TOOL_NAME] : others);
	});
	pi.on("tool_call", event => {
		if (event.toolName !== PI_RESULT_TOOL_NAME || structured) return;
		return {
			block: true,
			reason: `${PI_RESULT_TOOL_NAME} is only available for structured results.`,
		};
	});
}

type OutputTurn = HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions;

function isResultToolPart(part: HarnessV1StreamPart, suppressedIds: Set<string>): boolean {
	switch (part.type) {
		case "tool-input-start":
			if (part.toolName !== PI_RESULT_TOOL_NAME) return false;
			suppressedIds.add(part.id);
			return true;
		case "tool-input-delta":
		case "tool-input-end":
			if (!suppressedIds.has(part.id)) return false;
			if (part.type === "tool-input-end") suppressedIds.delete(part.id);
			return true;
		case "tool-call":
		case "tool-result":
			return part.toolName === PI_RESULT_TOOL_NAME;
		default:
			return false;
	}
}

/** Runs one turn through Pi. A JSON `responseFormat` becomes the extension's
 * result tool; any other turn passes through with the result tool's parts,
 * which the extension refused, kept out of the stream. */
async function runOutputTurn<T extends OutputTurn>(
	run: (options: T) => PromiseLike<HarnessV1PromptControl>,
	turn: T,
): Promise<HarnessV1PromptControl> {
	if (turn.tools.some(spec => spec.name === PI_RESULT_TOOL_NAME)) {
		throw new Error(`Host tool name ${PI_RESULT_TOOL_NAME} is reserved for structured output.`);
	}
	let suppressedIds = new Set<string>();
	let responseFormat = turn.responseFormat;
	if (responseFormat?.type !== "json") {
		return run({
			...turn,
			emit: part => {
				if (!isResultToolPart(part, suppressedIds)) turn.emit(part);
			},
		} as T);
	}

	let received: { value: unknown } | undefined;
	let parseError: Error | undefined;

	let wrappedEmit = (part: HarnessV1StreamPart) => {
		if (isResultToolPart(part, suppressedIds)) {
			if (part.type === "tool-call") {
				try {
					received = { value: JSON.parse(part.input || "{}") };
				} catch (cause) {
					parseError = new Error("Pi returned an invalid structured result.", { cause });
				}
			}
			return;
		}
		switch (part.type) {
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

	let schema = JSON.stringify(responseFormat.schema ?? { type: "object" });
	let resultInstructions = [
		PI_RESULT_INSTRUCTION,
		responseFormat.description,
		`The ${PI_RESULT_TOOL_NAME} arguments must match this JSON schema: ${schema}`,
	].filter(Boolean).join("\n");
	let control = await run({
		...turn,
		responseFormat: undefined,
		instructions: [turn.instructions, resultInstructions].filter(Boolean).join("\n\n"),
		emit: wrappedEmit,
	} as T);

	return {
		submitToolResult: input => control.submitToolResult(input),
		submitToolApproval: input => control.submitToolApproval?.(input) ?? Promise.resolve(),
		submitUserMessage: text => control.submitUserMessage?.(text) ?? Promise.resolve(),
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
	let pi = createPi({
		...settings,
		extensionFactories: [...(settings?.extensionFactories ?? []), piResultToolExtension],
	});
	return {
		...pi,
		async doStart(startOptions) {
			let session = await pi.doStart(startOptions);
			return wrapSession(session);
		},
		async shutdown() {},
	};
}
