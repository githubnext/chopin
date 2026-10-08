import { renderDiagram } from "@chopin/diagrams";

import { CHOICES, CRITERIA, GENERATOR_INSTRUCTIONS, isChoice } from "./catalogue";

import type { Choice } from "./catalogue";
import type { JevResult } from "../conversation-plan/jev";

export type SourceCase = {
	id: string;
	cluster: string;
	checkpoint: string;
	input: object;
};

export type ModelAnswer = {
	choice: Choice;
	specJson: Record<string, unknown> | null;
	content: string;
	evidenceIds: string[];
	rationale: string;
};

export type ModelAttempt = {
	requestedModel: string;
	latencyMs: number;
	usage: unknown | null;
	answer: ModelAnswer;
};

export type RecordEvent =
	| { kind: "jev"; caseId: string; result: JevResult }
	| { kind: "jev-error"; caseId: string; error: string }
	| {
		kind: "strategy";
		caseId: string;
		strategy: "direct" | "jev-one" | "jev-shortlist";
		allowed: Choice[];
		status: "complete" | "model-error" | "invalid-output" | "jev-error";
		model?: ModelAttempt;
		latencyMs?: number;
		problem?: string;
		render?:
			| { ok: true; body: string; viewBox: [number, number, number, number]; problems: unknown[] }
			| { ok: false; problems: unknown[] };
	};

export type ExperimentDeps = {
	askJev(input: object): Promise<JevResult>;
	generate(input: object, allowed: Choice[], instructions: string): Promise<ModelAttempt>;
	record(event: RecordEvent): Promise<void>;
};

/** One case is at most three strategy runs and one shared Jev request. */
export async function runCase(source: SourceCase, deps: ExperimentDeps): Promise<void> {
	let direct = async (
		strategy: "direct" | "jev-one" | "jev-shortlist",
		allowed: Choice[],
	) => {
		let started = performance.now();
		try {
			let model = await deps.generate(source.input, allowed, GENERATOR_INSTRUCTIONS);
			let answer = model.answer;
			let eventIds = new Set(((source.input as { events?: Array<{ id?: unknown }> }).events ?? [])
				.map(event => String(event.id)));
			if (answer.evidenceIds.some(id => !eventIds.has(id))) {
				await deps.record({
					kind: "strategy",
					caseId: source.id,
					strategy,
					allowed,
					status: "invalid-output",
					model,
					problem: "evidence ID is absent from source",
				});
				return;
			}
			if (!allowed.includes(answer.choice)) {
				await deps.record({
					kind: "strategy",
					caseId: source.id,
					strategy,
					allowed,
					status: "invalid-output",
					model,
					problem: "choice is outside permitted set",
				});
				return;
			}
			if (answer.choice === "prose" || answer.choice === "table") {
				let table = /^\|?.+\|.+\n\|?[\s:|-]+\|[\s:|-]+/m.test(answer.content);
				let valid = answer.specJson === null && answer.content.trim().length > 0
					&& (answer.choice !== "table" || table);
				await deps.record({
					kind: "strategy",
					caseId: source.id,
					strategy,
					allowed,
					status: valid ? "complete" : "invalid-output",
					model,
					...(valid ? {} : { problem: "prose/table output needs matching content and no spec" }),
				});
				return;
			}
			let spec = answer.specJson;
			if (
				!spec || typeof spec !== "object" || Array.isArray(spec)
				|| (spec as { type?: unknown }).type !== answer.choice
			) {
				await deps.record({
					kind: "strategy",
					caseId: source.id,
					strategy,
					allowed,
					status: "invalid-output",
					model,
					problem: "spec type differs from choice",
				});
				return;
			}
			let rendered = renderDiagram(spec);
			await deps.record({
				kind: "strategy",
				caseId: source.id,
				strategy,
				allowed,
				status: rendered.ok ? "complete" : "invalid-output",
				model,
				render: rendered.ok
					? {
						ok: true,
						body: rendered.body,
						viewBox: rendered.viewBox,
						problems: rendered.diagnostics,
					}
					: { ok: false, problems: rendered.problems },
			});
		} catch (error) {
			await deps.record({
				kind: "strategy",
				caseId: source.id,
				strategy,
				allowed,
				status: "model-error",
				latencyMs: Math.round(performance.now() - started),
				problem: String(error),
			});
		}
	};

	await direct("direct", [...CHOICES]);
	let jev: JevResult;
	try {
		jev = await deps.askJev(source.input);
		await deps.record({ kind: "jev", caseId: source.id, result: jev });
	} catch (error) {
		let problem = String(error);
		await deps.record({ kind: "jev-error", caseId: source.id, error: problem });
		for (let strategy of ["jev-one", "jev-shortlist"] as const) {
			await deps.record({
				kind: "strategy",
				caseId: source.id,
				strategy,
				allowed: [],
				status: "jev-error",
				problem,
			});
		}
		return;
	}
	let answer = jev.answers.visual;
	if (!answer || answer.type !== "choice" || !isChoice(answer.choice)) {
		throw new Error("Jev returned an unsupported visual choice");
	}
	let shortlist = [...CHOICES].sort((a, b) =>
		(answer.probabilities[b] ?? 0) - (answer.probabilities[a] ?? 0)
	).slice(0, 3);
	await direct("jev-one", [answer.choice]);
	await direct("jev-shortlist", shortlist);
}

export const JEV_QUESTION = {
	visual: {
		type: "choice" as const,
		instructions:
			"Choose the presentation that most clearly explains the supplied engineering source without adding facts. Choose prose if the evidence is uncertain or insufficient.",
		criteria: CRITERIA,
	},
};
