import type {
	HarnessV1,
	HarnessV1PromptControl,
	HarnessV1Session,
	HarnessV1StartOptions,
	HarnessV1StreamPart,
} from "./harness-v1";

/** The value a model should read for a finished host tool call, or nothing to leave it as returned. */
export type ModelOutput = (call: { toolName: string; input: unknown; output: unknown }) => unknown;

type Turn = { emit: (part: HarnessV1StreamPart) => void };

/**
 * The agent harness hands a host tool's return value to the model as is: it applies a tool's
 * `toModelOutput` only when a turn ends, to the messages it returns, never to the result the
 * model is waiting on. The Copilot SDK, Atomic and the attached client then show the model that
 * value, or its one-line JSON when it is not a string. This applies `modelOutput` to a result
 * on its way to the adapter, so a tool can return a structured value and show the model text.
 */
export function withModelOutput<T extends HarnessV1>(harness: T, modelOutput: ModelOutput): T {
	return {
		...harness,
		async doStart(options: HarnessV1StartOptions) {
			let session = await harness.doStart(options);
			let calls = new Map<string, { toolName: string; input: unknown }>();
			let seen = <O extends Turn>(turn: O): O => ({
				...turn,
				emit: part => {
					if (part.type === "tool-call") {
						let input: unknown;
						try {
							input = JSON.parse(part.input);
						} catch {
							input = undefined;
						}
						calls.set(part.toolCallId, { toolName: part.toolName, input });
					}
					turn.emit(part);
				},
			});
			let shown = (control: HarnessV1PromptControl): HarnessV1PromptControl => ({
				...control,
				submitToolResult: async submission => {
					let call = calls.get(submission.toolCallId);
					calls.delete(submission.toolCallId);
					let output: unknown;
					try {
						if (!submission.isError && call) {
							output = modelOutput({ ...call, output: submission.output });
						}
					} catch (error) {
						console.error(`[harness/model-output] ${call?.toolName}`, error);
					}
					return control.submitToolResult(
						output === undefined ? submission : { ...submission, output },
					);
				},
			});
			return {
				...session,
				doPromptTurn: async turn => shown(await session.doPromptTurn(seen(turn))),
				doContinueTurn: async turn => shown(await session.doContinueTurn(seen(turn))),
			} satisfies HarnessV1Session;
		},
	} as T;
}
