import type {
	BuildRecommendation,
	RecommendationEvidence,
} from "../../packages/protocol/recommendation";
import type {
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
} from "../../apps/server/src/harness/harness-v1";

export const VAGUE_ADVICE = "Check how people create open decisions";
export const BUILD_ADVICE = "Clarify open decisions in the existing interface";
export const REVISED_ADVICE = "Explain the open decision status";
export const CHANGED_DIRECTION = "Keep creation unchanged; focus only on explaining open status.";
export const PAUSE_REQUEST = "Let's pause planning; do not suggest a next step yet.";

function recommendation(evidence: RecommendationEvidence[]): BuildRecommendation | null {
	let repository = evidence.find(item => item.kind === "repository");
	let answered = evidence.find(item =>
		item.kind === "decision" && item.detail.includes('"status":"answered"')
	);
	let discussion = evidence.filter(item =>
		item.kind === "discussion" && item.id.startsWith("discussion:")
	);
	if (discussion.at(-1)?.detail.includes(PAUSE_REQUEST)) return null;
	let revised = discussion.some(item => item.detail.includes(CHANGED_DIRECTION));
	let supported = !!repository && !!answered;
	let cited = evidence.filter(item =>
		["document", "discussion", "repository", "decision", "research"].includes(item.kind)
	).slice(0, 8);
	if (!cited.length) throw new Error("Recommendation fixture requires actual supplied evidence");
	return {
		kind: supported ? "build" : "investigate",
		title: supported ? revised ? REVISED_ADVICE : BUILD_ADVICE : VAGUE_ADVICE,
		scope: supported
			? revised
				? "Add a short help line beside open status; keep the creation entry point in place."
				: "Label open decisions clearly and add a short explanation beside the existing creation action."
			: "Inspect the existing decision entry point before choosing a UI change.",
		reasons: supported
			? [
				"Repository evidence identifies the existing creation action.",
				"The saved decision keeps the first change small.",
			]
			: ["The feedback identifies confusion, but current creation behavior has not been observed."],
		dependencies: supported
			? []
			: ["Observe how open decisions are created and whether the entry point is discoverable."],
		optional: ["Broader onboarding can stay open."],
		evidenceIds: cited.map(item => item.id),
		nextAction: supported
			? revised
				? "Discuss a short explanation of open status while keeping creation unchanged."
				: "Discuss the smallest status label and help-copy change around the existing decision action."
			: "Inspect how open decisions are created, then discuss the smallest useful improvement.",
	};
}

/** Structured no-tool workers keep their real host contract, stream and output parser. */
export function fakeStructuredWorker(
	turn: HarnessV1PromptTurnOptions,
	prompt: string,
): HarnessV1PromptControl | undefined {
	if (turn.responseFormat?.type !== "json") return;
	let input: { evidence?: RecommendationEvidence[]; material?: unknown };
	try {
		input = JSON.parse(prompt);
	} catch {
		return;
	}
	if (!input.evidence && !input.material) return;
	if (turn.tools.length) throw new Error("e2e-fake structured worker received ambient tools");
	let result = input.evidence
		? { recommendation: recommendation(input.evidence) }
		: { description: "Plan for decision interface clarity" };
	let done = Promise.withResolvers<void>();
	let usage = {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	};
	queueMicrotask(() => {
		if (!turn.abortSignal?.aborted) {
			let id = crypto.randomUUID();
			turn.emit({ type: "text-start", id });
			turn.emit({ type: "text-delta", id, delta: JSON.stringify(result) });
			turn.emit({ type: "text-end", id });
			turn.emit({ type: "finish-step", finishReason: { unified: "stop", raw: undefined }, usage });
			turn.emit({
				type: "finish",
				finishReason: { unified: "stop", raw: undefined },
				totalUsage: usage,
			});
		}
		done.resolve();
	});
	return { done: done.promise, async submitToolResult() {}, async submitToolApproval() {} };
}
