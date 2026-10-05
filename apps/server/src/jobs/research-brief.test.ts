import { expect, test } from "bun:test";
import {
	parseResearchBriefInput,
	researchBriefDefinition,
	type ResearchBriefInput,
	sourceId,
} from "./research-brief";
import type { JobExecution } from "./registry";

function input(): ResearchBriefInput {
	return {
		offerId: "offer",
		generation: 1,
		mode: "automatic",
		previousBrief: "",
		parentBrief: "",
		context: { messages: [], decisions: [] },
		sources: [{
			messageId: "m",
			author: { kind: "member", handle: "ana" },
			quote: "Investigate Jev alternatives.",
			start: 0,
			end: "Investigate Jev alternatives.".length,
		}],
	};
}

test("brief worker accepts only bounded source-grounded output", async () => {
	let material = input();
	let definition = researchBriefDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({
			brief: "Compare Jev alternatives.",
			sourceIds: [sourceId(material.sources[0]!)],
			model: "fixture",
		}),
	});
	let result = await definition.execute({ input: material } as JobExecution<ResearchBriefInput>);
	expect(result).toMatchObject({
		offerId: "offer",
		generation: 1,
		brief: "Compare Jev alternatives.",
	});
	expect(definition.credential).toBe("active-planner");
	expect(definition.origins).toEqual(["scheduler"]);
	let invalid = researchBriefDefinition({
		config: { agent: true, model: "fixture" },
		engine: async () => ({
			brief: "Invented scope",
			sourceIds: ["not-provided"],
			model: "fixture",
		}),
	});
	await expect(invalid.execute({ input: material } as JobExecution<ResearchBriefInput>)).rejects
		.toThrow("brief-source-invalid");
});

test("brief input rejects extra capabilities and oversized context", () => {
	expect(parseResearchBriefInput(input())).toEqual(input());
	expect(() => parseResearchBriefInput({ ...input(), token: "secret" })).toThrow();
	expect(() =>
		parseResearchBriefInput({
			...input(),
			context: {
				messages: [{
					id: "large",
					author: { kind: "member", handle: "ana" },
					text: "x".repeat(25000),
				}],
				decisions: [],
			},
		})
	).toThrow();
});
