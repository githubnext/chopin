/** Validates a raw TypeSafe System One response, for harnesses that inspect Jev's own wire. */
import type { JevAnswer, JevQuestion } from "../apps/server/src/conversation-plan/jev";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid Jev response");
	}
	return value as Record<string, unknown>;
}
function probability(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("invalid Jev probability");
	}
	return value;
}
function keysMatch(actual: Record<string, unknown>, expected: readonly string[]): void {
	let keys = Object.keys(actual);
	if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
		throw new Error("invalid Jev answer keys");
	}
}
function distribution(value: unknown, expected: readonly string[]): Record<string, number> {
	let raw = object(value);
	keysMatch(raw, expected);
	let result: Record<string, number> = {};
	for (let key of expected) result[key] = probability(raw[key]);
	let total = Object.values(result).reduce((sum, item) => sum + item, 0);
	if (Math.abs(total - 1) > 0.08) throw new Error("invalid Jev distribution");
	return result;
}

export function validateJevResponse(
	value: unknown,
	questions: Record<string, JevQuestion>,
): {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
} {
	let response = object(value);
	if (typeof response.model !== "string" || !response.model || response.model.length > 100) {
		throw new Error("invalid Jev model");
	}
	let usage = object(response.usage);
	for (let count of [usage.input_tokens, usage.output_tokens]) {
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("invalid Jev usage");
	}
	let rawAnswers = object(response.answers);
	keysMatch(rawAnswers, Object.keys(questions));
	let answers: Record<string, JevAnswer> = {};
	for (let [id, question] of Object.entries(questions)) {
		let raw = object(rawAnswers[id]);
		if (raw.type !== question.type) throw new Error("invalid Jev answer type");
		if (question.type === "noul") {
			keysMatch(raw, ["type", "noul"]);
			answers[id] = { type: "noul", noul: probability(raw.noul) };
		} else if (question.type === "choice") {
			keysMatch(raw, ["type", "choice", "confidence", "probabilities"]);
			let options = Object.keys(question.criteria);
			let probabilities = distribution(raw.probabilities, options);
			if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
				throw new Error("invalid Jev choice");
			}
			if (probabilities[raw.choice] + 0.01 < Math.max(...Object.values(probabilities))) {
				throw new Error("invalid Jev winning choice");
			}
			answers[id] = {
				type: "choice",
				choice: raw.choice,
				confidence: probability(raw.confidence),
				probabilities,
			};
		} else {
			keysMatch(raw, ["type", "score", "confidence", "legend", "probabilities"]);
			let levels = question.criteria.map((_, index) => String(index));
			let legend = object(raw.legend);
			keysMatch(legend, levels);
			for (let [index, label] of question.criteria.entries()) {
				if (legend[String(index)] !== label) throw new Error("invalid Jev score legend");
			}
			let probabilities = distribution(raw.probabilities, levels);
			let weighted = levels.reduce((sum, key, index) => sum + index * probabilities[key], 0);
			if (
				typeof raw.score !== "number" || !Number.isFinite(raw.score)
				|| raw.score < 0 || raw.score > levels.length - 1
				|| Math.abs(raw.score - weighted) > 0.12
			) throw new Error("invalid Jev score");
			answers[id] = {
				type: "score",
				score: raw.score,
				confidence: probability(raw.confidence),
				legend: legend as Record<string, string>,
				probabilities,
			};
		}
	}
	return {
		model: response.model,
		answers,
		usage: {
			input_tokens: usage.input_tokens as number,
			output_tokens: usage.output_tokens as number,
		},
	};
}
