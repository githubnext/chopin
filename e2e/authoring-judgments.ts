import type { JevRequest, JevResult } from "../apps/server/src/conversation-plan/jev";

const SEQUENCE_PASSAGE = "The browser sends a request to the server, which returns a response.";
const INPUT_REQUESTS = new Set(["Which option should we use?", "Tell me which option to use."]);

/** Deterministic answers at the external classifier boundary; all admission policy stays real. */
export function authoringJudgment(
	request: JevRequest,
): Omit<JevResult, "latencyMs"> | undefined {
	let state = request.state as {
		reply?: string;
		passages?: Array<{ index: number; source: string }>;
	};
	let entries = Object.entries(request.questions);
	let answers: JevResult["answers"] = {};
	if (
		entries.length === 1 && request.questions.input?.type === "noul"
		&& typeof state?.reply === "string"
	) {
		answers.input = { type: "noul", noul: INPUT_REQUESTS.has(state.reply) ? 0.97 : 0.03 };
	} else if (
		entries.length > 0 && entries.every(([id]) => /^[pht]\d+$/.test(id))
		&& Array.isArray(state?.passages)
	) {
		for (let [id, question] of entries) {
			let passage = state.passages.find(item => item.index === Number(id.slice(1)));
			if (!passage || typeof passage.source !== "string") return;
			let selected = passage.source.includes(SEQUENCE_PASSAGE);
			if (question.type === "noul") {
				answers[id] = { type: "noul", noul: selected ? 0.97 : 0.03 };
			} else if (question.type === "choice" && selected && question.criteria.sequence) {
				let keys = Object.keys(question.criteria);
				answers[id] = {
					type: "choice",
					choice: "sequence",
					confidence: 0.98,
					probabilities: Object.fromEntries(keys.map(key => [
						key,
						key === "sequence" ? 0.98 : 0.02 / (keys.length - 1),
					])),
				};
			} else return;
		}
	} else return;
	return {
		model: "jev-e2e-authoring",
		answers,
		usage: { input_tokens: 10, output_tokens: 5 },
	};
}
