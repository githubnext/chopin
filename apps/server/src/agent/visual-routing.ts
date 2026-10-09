import {
	askJev,
	type JevQuestion,
	type JevRequest,
	type JevResult,
} from "../conversation-plan/jev";
import { visualChoices } from "./visual-catalog";

export type VisualPassage = { index: number; source: string };
export type VisualRoute =
	| {
		index: number;
		kind: "prose";
		reason:
			| "not-visualizable"
			| "no-explanatory-gain"
			| "no-suitable-type"
			| "assessment-unavailable";
		possibility?: number;
		helpfulness?: number;
	}
	| {
		index: number;
		kind: "table" | "diagram";
		type?: string;
		possibility: number;
		helpfulness: number;
		confidence: number;
	};
export type VisualAssessment = {
	routes: VisualRoute[];
	passes: JevResult[];
	failure?: {
		stage: "possibility" | "helpfulness" | "type";
		reason: "timeout" | "invalid-response" | "unavailable";
	};
};
export type VisualInput = { passages: VisualPassage[]; readerQuestion: string };
export type JevAsk = (request: JevRequest) => Promise<JevResult>;

function bounds(input: VisualInput): void {
	if (input.passages.length < 1 || input.passages.length > 8) {
		throw new Error("visual assessment needs 1 to 8 passages");
	}
	if (input.readerQuestion.length > 1_000) {
		throw new Error("reader question exceeds 1000 characters");
	}
	let indices = new Set<number>();
	for (let passage of input.passages) {
		if (!Number.isSafeInteger(passage.index) || passage.index < 0 || indices.has(passage.index)) {
			throw new Error("visual passage index is invalid or repeated");
		}
		indices.add(passage.index);
		if (!passage.source.trim()) throw new Error("visual passage is empty");
		if (passage.source.length > 2_000) throw new Error("passage exceeds 2000 characters");
	}
}

function answer(result: JevResult, key: string, type: "noul"): number;
function answer(result: JevResult, key: string, type: "choice", choices: Record<string, string>): {
	choice: string;
	confidence: number;
};
function answer(
	result: JevResult,
	key: string,
	type: "noul" | "choice",
	choices?: Record<string, string>,
): number | { choice: string; confidence: number } {
	let found = result.answers[key];
	if (found?.type !== type) throw new Error("invalid Jev visual answer");
	if (type === "noul") {
		let probability = (found as Extract<typeof found, { type: "noul" }>).noul;
		if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
			throw new Error("invalid Jev visual probability");
		}
		return probability;
	}
	let choice = found as Extract<typeof found, { type: "choice" }>;
	if (!choices || !Object.hasOwn(choices, choice.choice)) {
		throw new Error("invalid Jev visual choice");
	}
	if (!Number.isFinite(choice.confidence) || choice.confidence < 0 || choice.confidence > 1) {
		throw new Error("invalid Jev visual confidence");
	}
	return { choice: choice.choice, confidence: choice.confidence };
}

/** Three small Jev decisions; all factual rendering remains the Planner's task. */
export async function assessVisual(
	input: VisualInput,
	ask: JevAsk = askJev,
): Promise<VisualAssessment> {
	bounds(input);
	let routes = new Map<number, VisualRoute>();
	let passes: JevResult[] = [];
	let pending = [...input.passages];
	let model: string | undefined;
	let stage: "possibility" | "helpfulness" | "type" = "possibility";
	let failure: VisualAssessment["failure"];
	let call = async (passages: VisualPassage[], questions: Record<string, JevQuestion>) => {
		let state = { readerQuestion: input.readerQuestion, passages };
		let result = await ask({ state, questions });
		if (model && result.model !== model) throw new Error("inconsistent Jev model versions");
		model = result.model;
		passes.push(result);
		return result;
	};
	try {
		let possibilityQuestions: Record<string, JevQuestion> = {};
		for (let passage of pending) {
			possibilityQuestions[`p${passage.index}`] = {
				type: "noul",
				instructions:
					`Can passage ${passage.index} be faithfully visualized using only its stated facts? Include a comparison table as a visual. Do not invent a relation, order, branch, or value.`,
				criteria: {
					true:
						"A visual can represent at least one supported relation, contrast, order, change, or measurement.",
					false: "The passage has no supported visual structure.",
				},
			};
		}
		let possibility = await call(pending, possibilityQuestions);
		let possible = pending.filter(passage => {
			let value = answer(possibility, `p${passage.index}`, "noul");
			if (value >= 0.5) return true;
			routes.set(passage.index, {
				index: passage.index,
				kind: "prose",
				reason: "not-visualizable",
				possibility: value,
			});
			return false;
		});
		pending = possible;
		if (pending.length) {
			stage = "helpfulness";
			let helpfulQuestions: Record<string, JevQuestion> = {};
			for (let passage of pending) {
				helpfulQuestions[`h${passage.index}`] = {
					type: "noul",
					instructions:
						`Would a faithful visual of passage ${passage.index} expose a relation, contrast, order, or change that a reader would otherwise have to assemble mentally? Prose need not be inadequate; ask whether the visual adds comprehension value.`,
					criteria: {
						true: "A visual makes supported structure quicker or clearer to grasp.",
						false: "A visual would only repeat an isolated claim or decorate the text.",
					},
				};
			}
			let helpfulness = await call(pending, helpfulQuestions);
			let helpful = pending.filter(passage => {
				let possibleAnswer = answer(possibility, `p${passage.index}`, "noul");
				let helpfulAnswer = answer(helpfulness, `h${passage.index}`, "noul");
				if (helpfulAnswer >= 0.5) return true;
				routes.set(passage.index, {
					index: passage.index,
					kind: "prose",
					reason: "no-explanatory-gain",
					possibility: possibleAnswer,
					helpfulness: helpfulAnswer,
				});
				return false;
			});
			pending = helpful;
			if (pending.length) {
				stage = "type";
				let choices = visualChoices();
				let typeQuestions: Record<string, JevQuestion> = {};
				for (let passage of pending) {
					typeQuestions[`t${passage.index}`] = {
						type: "choice",
						instructions:
							`Which supported visual type best fits passage ${passage.index}? Choose none only when every type would need invented facts.`,
						criteria: choices,
					};
				}
				let types = await call(pending, typeQuestions);
				for (let passage of pending) {
					let selected = answer(types, `t${passage.index}`, "choice", choices);
					let common = {
						index: passage.index,
						possibility: answer(possibility, `p${passage.index}`, "noul"),
						helpfulness: answer(helpfulness, `h${passage.index}`, "noul"),
					};
					if (selected.choice === "none") {
						routes.set(passage.index, { ...common, kind: "prose", reason: "no-suitable-type" });
					} else if (selected.choice === "table") {
						routes.set(passage.index, {
							...common,
							kind: "table",
							confidence: selected.confidence,
						});
					} else {
						routes.set(passage.index, {
							...common,
							kind: "diagram",
							type: selected.choice,
							confidence: selected.confidence,
						});
					}
				}
			}
		}
	} catch (error) {
		let message = error instanceof Error ? error.message : "";
		failure = {
			stage,
			reason: message.includes("timed out")
				? "timeout"
				: message.includes("invalid Jev") || message.includes("inconsistent Jev")
				? "invalid-response"
				: "unavailable",
		};
		for (let passage of pending) {
			routes.set(passage.index, {
				index: passage.index,
				kind: "prose",
				reason: "assessment-unavailable",
			});
		}
	}
	return {
		routes: input.passages.map(passage => routes.get(passage.index)!),
		passes,
		...(failure && { failure }),
	};
}
