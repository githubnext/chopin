import type { JevRequest, JevResult } from "../apps/server/src/conversation-plan/jev";

const INPUT_REQUESTS = new Set(["Which option should we use?", "Tell me which option to use."]);

/** Deterministic answers at the external classifier boundary; reply policy stays real. */
export function authoringJudgment(
	request: JevRequest,
): Omit<JevResult, "latencyMs"> | undefined {
	let state = request.state as { reply?: string };
	let entries = Object.entries(request.questions);
	if (
		entries.length === 1 && request.questions.input?.type === "noul"
		&& typeof state?.reply === "string"
	) {
		return {
			model: "jev-e2e-authoring",
			answers: {
				input: { type: "noul", noul: INPUT_REQUESTS.has(state.reply) ? 0.97 : 0.03 },
			},
			usage: { input_tokens: 10, output_tokens: 5 },
		};
	}
	return undefined;
}
