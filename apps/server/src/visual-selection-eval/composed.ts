import { renderDiagram } from "@chopin/diagrams";

import { CHOICES } from "./catalogue";
import {
	ADDED_VALUE_QUESTION,
	COMPOSED_GENERATOR_INSTRUCTIONS,
	FAITHFULNESS_QUESTION,
	generatorChoices,
	OPPORTUNITY_QUESTION,
	supportedType,
	TYPE_QUESTION,
} from "./composed-catalogue";

import type { JevQuestion, JevResult } from "../conversation-plan/jev";
import type { Choice } from "./catalogue";
import type { ComposedCase } from "./composed-source";
import type { ModelAnswer, ModelAttempt } from "./experiment";

type Path = "direct" | "composed";
type Render =
	| { ok: true; body: string; viewBox: [number, number, number, number]; problems: unknown[] }
	| { ok: false; problems: unknown[] };

export type ComposedEvent =
	| { kind: "opportunity"; caseId: string; result: JevResult; yes: boolean }
	| { kind: "representation"; caseId: string; result: JevResult; choice: string }
	| {
		kind: "generation";
		caseId: string;
		path: Path;
		allowed: Choice[];
		status: string;
		model?: ModelAttempt;
		latencyMs?: number;
		problem?: string;
		rawText?: string | null;
		render?: Render;
	}
	| {
		kind: "critic";
		caseId: string;
		path: Path;
		check: "faithfulness" | "added-value";
		result: JevResult;
	}
	| { kind: "skip"; caseId: string; path: Path; reason: string }
	| { kind: "jev-error"; caseId: string; stage: string; error: string };

export type ComposedDeps = {
	askJev(state: object, questions: Record<string, JevQuestion>): Promise<JevResult>;
	generate(input: object, allowed: Choice[], instructions: string): Promise<ModelAttempt>;
	record(event: ComposedEvent): Promise<void>;
};

function sourceInput(item: ComposedCase): object {
	return {
		documentTitle: item.input.documentTitle,
		heading: item.input.heading,
		evidence: [{ id: "passage", text: item.input.passage }],
	};
}

function validate(model: ModelAttempt, allowed: Choice[]): {
	status: string;
	problem?: string;
	render?: Render;
} {
	let answer = model.answer;
	if (!allowed.includes(answer.choice)) {
		return { status: "invalid-output", problem: "choice outside permitted set" };
	}
	if (answer.evidenceIds.length === 0 || answer.evidenceIds.some(id => id !== "passage")) {
		return { status: "invalid-output", problem: "missing or unknown evidence ID" };
	}
	if (answer.choice === "prose" || answer.choice === "table") {
		let table = /^\|?.+\|.+\n\|?[\s:|-]+\|[\s:|-]+/m.test(answer.content);
		let valid = answer.specJson === null && answer.content.trim().length > 0
			&& (answer.choice !== "table" || table);
		return valid
			? { status: "complete" }
			: { status: "invalid-output", problem: "prose/table needs content and no spec" };
	}
	let spec = answer.specJson;
	if (!spec || spec.type !== answer.choice) {
		return { status: "invalid-output", problem: "spec type differs from choice" };
	}
	try {
		let rendered = renderDiagram(spec);
		return rendered.ok
			? {
				status: "complete",
				render: {
					ok: true,
					body: rendered.body,
					viewBox: rendered.viewBox,
					problems: rendered.diagnostics,
				},
			}
			: {
				status: "invalid-spec",
				render: { ok: false, problems: rendered.problems },
			};
	} catch (error) {
		return { status: "renderer-error", problem: String(error) };
	}
}

/** Three frozen passages, at most six primary generations and twenty Jev calls. */
export async function runComposed(cases: ComposedCase[], deps: ComposedDeps): Promise<void> {
	if (cases.length !== 3) throw new Error("Expected exactly three frozen cases");
	let modelCalls = 0;
	let jevCalls = 0;
	let ask = async (state: object, questions: Record<string, JevQuestion>) => {
		if (++jevCalls > 20) throw new Error("Jev call budget exceeded");
		return deps.askJev(state, questions);
	};
	let generate = async (item: ComposedCase, path: Path, allowed: Choice[]) => {
		if (++modelCalls > 6) throw new Error("Primary generation budget exceeded");
		let started = performance.now();
		try {
			let model = await deps.generate(
				sourceInput(item),
				allowed,
				COMPOSED_GENERATOR_INSTRUCTIONS,
			);
			let result = validate(model, allowed);
			await deps.record({
				kind: "generation",
				caseId: item.id,
				path,
				allowed,
				model,
				...result,
			});
			return result.status === "complete" ? model.answer : undefined;
		} catch (error) {
			let detail = error as { text?: unknown };
			await deps.record({
				kind: "generation",
				caseId: item.id,
				path,
				allowed,
				status: "model-error",
				latencyMs: Math.round(performance.now() - started),
				problem: String(error),
				rawText: typeof detail.text === "string" ? detail.text : null,
			});
			return undefined;
		}
	};
	let reviewCandidate = async (item: ComposedCase, path: Path, answer?: ModelAnswer) => {
		if (!answer || answer.choice === "prose") return;
		let state = {
			source: sourceInput(item),
			candidate: {
				choice: answer.choice,
				specJson: answer.specJson,
				content: answer.content,
			},
		};
		for (
			let [check, question] of [
				["faithfulness", FAITHFULNESS_QUESTION],
				["added-value", ADDED_VALUE_QUESTION],
			] as const
		) {
			try {
				let result = await ask(state, question);
				await deps.record({ kind: "critic", caseId: item.id, path, check, result });
			} catch (error) {
				await deps.record({
					kind: "jev-error",
					caseId: item.id,
					stage: `${path}-${check}`,
					error: String(error),
				});
			}
		}
	};
	for (let item of cases) {
		let input = sourceInput(item);
		let direct = await generate(item, "direct", [...CHOICES]);
		await reviewCandidate(item, "direct", direct);
		let opportunity: JevResult;
		try {
			opportunity = await ask(input, OPPORTUNITY_QUESTION);
		} catch (error) {
			await deps.record({
				kind: "jev-error",
				caseId: item.id,
				stage: "opportunity",
				error: String(error),
			});
			continue;
		}
		let answer = opportunity.answers.opportunity;
		if (answer?.type !== "noul") throw new Error("Invalid opportunity answer");
		let yes = answer.noul >= 0.5;
		await deps.record({ kind: "opportunity", caseId: item.id, result: opportunity, yes });
		if (!yes) {
			await deps.record({
				kind: "skip",
				caseId: item.id,
				path: "composed",
				reason: "opportunity-no",
			});
		} else {
			let selection: JevResult;
			try {
				selection = await ask(input, TYPE_QUESTION);
			} catch (error) {
				await deps.record({
					kind: "jev-error",
					caseId: item.id,
					stage: "representation",
					error: String(error),
				});
				continue;
			}
			let choice = selection.answers.representation;
			if (choice?.type !== "choice") throw new Error("Invalid representation answer");
			await deps.record({
				kind: "representation",
				caseId: item.id,
				result: selection,
				choice: choice.choice,
			});
			if (!supportedType(choice.choice)) {
				await deps.record({
					kind: "skip",
					caseId: item.id,
					path: "composed",
					reason: "no-supported-type",
				});
			} else {
				let composed = await generate(item, "composed", generatorChoices(choice.choice));
				await reviewCandidate(item, "composed", composed);
			}
		}
	}
}
