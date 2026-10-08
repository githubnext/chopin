import { expect, test } from "bun:test";

import { CHOICES } from "./catalogue";
import { COMPOSED_GENERATOR_INSTRUCTIONS, TYPE_QUESTION } from "./composed-catalogue";
import { runComposed } from "./composed";

import type { JevQuestion, JevResult } from "../conversation-plan/jev";
import type { ComposedEvent } from "./composed";
import type { ComposedCase } from "./composed-source";
import type { ModelAnswer } from "./experiment";

let cases: ComposedCase[] = ["first", "second", "control"].map(id => ({
	id,
	cluster: id,
	input: { documentTitle: id, heading: "Heading", passage: `Passage ${id}` },
	passageSha256: "fixture",
	source: {
		path: id,
		sha256: "fixture",
		snapshot: "fixture",
		cutoff: "fixture",
		adaptation: "none",
	},
}));

function jev(answers: JevResult["answers"]): JevResult {
	return { model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1 };
}

function answer(choice: ModelAnswer["choice"]): ModelAnswer {
	return {
		choice,
		specJson: choice === "dependency"
			? { type: "dependency", nodes: [{ id: "a", label: "A" }] }
			: null,
		content: choice === "table"
			? "| Case | Value |\n|---|---|\n| A | B |"
			: "A concise explanation.",
		evidenceIds: ["passage"],
		rationale: "fixture",
	};
}

test("composed flow shares source and generator while checking both visual paths", async () => {
	let events: ComposedEvent[] = [];
	let calls: Array<{ title: string; allowed: string[]; instructions: string }> = [];
	let jevCalls: Array<{ title: string; stage: string }> = [];
	await runComposed(cases, {
		async askJev(state, questions: Record<string, JevQuestion>) {
			let title = (state as { documentTitle?: string; source?: { documentTitle: string } })
				.documentTitle ?? (state as { source: { documentTitle: string } }).source.documentTitle;
			let stage = Object.keys(questions)[0]!;
			jevCalls.push({ title, stage });
			if (stage === "opportunity") {
				return jev({ opportunity: { type: "noul", noul: title === "control" ? 0.1 : 0.9 } });
			}
			if (stage === "representation") {
				let choice = title === "first" ? "dependency" : "table";
				return jev({
					representation: {
						type: "choice",
						choice,
						confidence: 0.8,
						probabilities: Object.fromEntries(
							Object.keys((TYPE_QUESTION.representation as { criteria: object }).criteria)
								.map(key => [key, key === choice ? 1 : 0]),
						),
					},
				});
			}
			return jev({ [stage]: { type: "noul", noul: 0.8 } });
		},
		async generate(input, allowed, instructions) {
			let title = (input as { documentTitle: string }).documentTitle;
			calls.push({ title, allowed, instructions });
			let choice = allowed.length === CHOICES.length
				? title === "first" ? "table" : "prose"
				: allowed[0]!;
			return { requestedModel: "test", latencyMs: 1, usage: null, answer: answer(choice) };
		},
		async record(event) {
			events.push(event);
		},
	});
	expect(calls).toHaveLength(5);
	expect(calls.every(call => call.instructions === COMPOSED_GENERATOR_INSTRUCTIONS)).toBe(true);
	expect(calls.filter(call => call.title === "first").map(call => call.allowed))
		.toEqual([[...CHOICES], ["dependency", "prose"]]);
	expect(events.filter(event => event.kind === "generation" && event.render?.ok)).toHaveLength(1);
	expect(events.filter(event => event.kind === "critic")).toHaveLength(6);
	expect(jevCalls).toHaveLength(11);
	expect(events.filter(event => event.kind === "skip")).toEqual([
		{ kind: "skip", caseId: "control", path: "composed", reason: "opportunity-no" },
	]);
});
