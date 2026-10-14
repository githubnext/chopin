import {
	parseDocumentDevelopmentInput,
	parseDocumentDevelopmentOutput,
} from "../../apps/server/src/document-development/schema";
import type { JsonValue } from "../../apps/server/src/storage/model";
import type {
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
} from "../../apps/server/src/harness/harness-v1";

export const COWORKER_FEEDBACK = "I'm not sure I understand the decision primitive. From its name, "
	+ "I assume it's only for things that are already decided, or are there open decisions? "
	+ "I'm not sure how to invoke a decision - can I do that manually? "
	+ "A little bit of onboarding to what decisions are and how you use them might help here.";
export const DISAGREEMENT = "I disagree that onboarding is the answer. I'd first try clearer names "
	+ "and a visible way to create an open decision.";
export const CORRECTION = "Correction: try a visible Create decision action before renaming. "
	+ "The onboarding question is still open; we have not agreed on a solution.";
export const UNCHANGED = "Thanks, nothing to add.";
export const OBSERVATION = "Reported observation: ana could not tell whether decisions can be open "
	+ "or how to create one. Naming, status and creation discoverability need investigation.";
export const HUMAN_NOTE = " Human note: preserve the distinction between status and creation.";
export const EXPERIMENT =
	"Proposal: compare clearer names and a visible creation action in a small "
	+ "prototype. Open question: what was ana trying to accomplish when the confusion appeared?";
export const CORRECTED_EXPERIMENT = "Proposal: first test a visible Create decision action. "
	+ "Open question: would onboarding help after the creation path is clear? No solution is agreed.";

function synthesis(value: JsonValue): JsonValue {
	let input = parseDocumentDevelopmentInput(value);
	let latest = input.messages.at(-1)!;
	let output = { changes: [], removals: [] } as ReturnType<typeof parseDocumentDevelopmentOutput>;
	let feedback = input.messages.find(message => message.text === COWORKER_FEEDBACK);
	let disagreement = input.messages.find(message => message.text === DISAGREEMENT);
	if (latest.text === UNCHANGED || !feedback) return output;
	if (latest.text === CORRECTION) {
		let protectedPassage = input.passages.find(passage => passage.markdown.includes(HUMAN_NOTE));
		if (!protectedPassage || protectedPassage.editable) {
			throw new Error("document-development fixture lost human passage protection");
		}
		let target = input.passages.find(passage =>
			passage.markdown === EXPERIMENT && passage.editable
		);
		if (!target) throw new Error("document-development fixture has no editable experiment");
		output.changes.push({
			id: target.id,
			markdown: CORRECTED_EXPERIMENT,
			sourceIds: [latest.id],
		});
	} else if (!input.passages.length && disagreement) {
		output.changes = [
			{ id: null, markdown: OBSERVATION, sourceIds: [feedback.id] },
			{
				id: null,
				markdown: `Open question: ${feedback.author} suggests onboarding; ${disagreement.author} `
					+ "prefers clearer names and a visible creation action. These are competing proposals, "
					+ "not a team decision.",
				sourceIds: [feedback.id, disagreement.id],
			},
			{ id: null, markdown: EXPERIMENT, sourceIds: [feedback.id, disagreement.id] },
		];
	}
	return parseDocumentDevelopmentOutput(output, input);
}

/** Only model output is scripted: the host worker, job ledger and publication stay real. */
export function documentDevelopmentTurn(
	turn: HarnessV1PromptTurnOptions,
	prompt: string,
): HarnessV1PromptControl | undefined {
	if (turn.responseFormat?.type !== "json") return;
	let value: JsonValue;
	try {
		value = JSON.parse(prompt) as JsonValue;
	} catch {
		return;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	let output: JsonValue;
	if ("messageId" in value) {
		output = synthesis(value);
	} else if ("material" in value) {
		let material = value.material;
		if (!material || typeof material !== "object" || Array.isArray(material)) return;
		if (
			!["final-document", "document-chunk", "description-reduction"].includes(String(material.kind))
		) return;
		output = { description: "Planning document about decision discoverability" };
	} else return;
	if (turn.tools.length) throw new Error("private structured fixture received host tools");
	let settled = Promise.withResolvers<void>();
	queueMicrotask(() => {
		try {
			if (turn.abortSignal?.aborted) {
				settled.resolve();
				return;
			}
			let usage = {
				inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 0, text: 0, reasoning: 0 },
			};
			turn.emit({ type: "text-start", id: "structured" });
			turn.emit({ type: "text-delta", id: "structured", delta: JSON.stringify(output) });
			turn.emit({ type: "text-end", id: "structured" });
			turn.emit({ type: "finish-step", finishReason: { unified: "stop", raw: undefined }, usage });
			turn.emit({
				type: "finish",
				finishReason: { unified: "stop", raw: undefined },
				totalUsage: usage,
			});
			settled.resolve();
		} catch (error) {
			settled.reject(error);
		}
	});
	return { done: settled.promise, async submitToolResult() {}, async submitToolApproval() {} };
}
