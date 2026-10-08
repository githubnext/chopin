import { expect, test } from "bun:test";

import { CHOICES, GENERATOR_INSTRUCTIONS } from "./catalogue";
import { runCase } from "./experiment";

import type { ExperimentDeps, RecordEvent, SourceCase } from "./experiment";

let source: SourceCase = {
	id: "development/c1",
	cluster: "development",
	checkpoint: "c1",
	input: { events: [{ id: "e1", body: "A depends on B." }] },
};

test("direct, single choice, and shortlist share source and generator instructions", async () => {
	let calls: Array<{ input: object; allowed: string[]; instructions: string }> = [];
	let events: RecordEvent[] = [];
	let deps: ExperimentDeps = {
		async askJev(input) {
			expect(input).toBe(source.input);
			return {
				model: "jev-test",
				latencyMs: 11,
				usage: { input_tokens: 10, output_tokens: 3 },
				answers: {
					visual: {
						type: "choice",
						choice: "dependency",
						confidence: 0.8,
						probabilities: {
							dependency: 0.5,
							sequence: 0.2,
							state: 0.2,
							flowchart: 0.05,
							table: 0.03,
							prose: 0.02,
						},
					},
				},
			};
		},
		async generate(input, allowed, instructions) {
			calls.push({ input, allowed, instructions });
			return {
				requestedModel: "test-model",
				latencyMs: 1,
				usage: null,
				answer: {
					choice: allowed[0]!,
					specJson: allowed[0] === "dependency"
						? JSON.stringify({ type: "dependency", nodes: [{ id: "a", label: "A" }] })
						: null,
					content: "A depends on B.",
					evidenceIds: ["e1"],
					rationale: "test",
				},
			};
		},
		async record(event) {
			events.push(event);
		},
	};
	await runCase(source, deps);
	expect(calls.map(call => call.allowed)).toEqual([
		[...CHOICES],
		["dependency"],
		["dependency", "sequence", "state"],
	]);
	expect(calls.every(call =>
		call.input === source.input
		&& call.instructions === GENERATOR_INSTRUCTIONS
	)).toBe(true);
	expect(events.filter(event => event.kind === "jev")).toHaveLength(1);
	expect(events.filter(event => event.kind === "strategy")).toHaveLength(3);
	expect(events.filter(event => event.kind === "strategy" && event.render?.ok))
		.toHaveLength(3);
});

test("Jev failure is recorded without pretending the guided strategies ran", async () => {
	let events: RecordEvent[] = [];
	await runCase(source, {
		async askJev() {
			throw new Error("unavailable");
		},
		async generate() {
			return {
				requestedModel: "test",
				latencyMs: 1,
				usage: null,
				answer: {
					choice: "prose",
					specJson: null,
					content: "A depends on B.",
					evidenceIds: ["e1"],
					rationale: "test",
				},
			};
		},
		async record(event) {
			events.push(event);
		},
	});
	expect(events.filter(event => event.kind === "jev-error")).toHaveLength(1);
	expect(events.filter(event => event.kind === "strategy").map(event => event.status))
		.toEqual(["complete", "jev-error", "jev-error"]);
});
