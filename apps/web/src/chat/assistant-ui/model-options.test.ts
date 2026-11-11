import { describe, expect, it } from "bun:test";

import { modelOptions } from "./model-options";

describe("model options for the copied model selector", () => {
	it("offers nothing where the harness offers no choice", () => {
		expect(modelOptions(undefined)).toEqual([]);
		expect(modelOptions({ models: [] })).toEqual([]);
	});

	it("keeps each model's id, name and description exactly as reported", () => {
		expect(
			modelOptions({
				models: [{
					id: "claude-sonnet-4",
					name: "Claude Sonnet 4",
					description: "Careful writing",
				}],
			}),
		).toEqual([{ id: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Careful writing" }]);
	});

	it("gives a model with no levels no reasoning control", () => {
		expect(modelOptions({ models: [{ id: "a", name: "A", thinkingLevels: [] }] })[0]).toEqual({
			id: "a",
			name: "A",
		});
	});

	it("keeps every level as the harness spelled it, so a choice is what a turn carries", () => {
		let [model] = modelOptions({
			models: [{ id: "m", name: "M", thinkingLevels: ["high", "High", "xhigh"] }],
		});
		expect(model?.efforts).toEqual([
			{ id: "high", name: "high" },
			{ id: "High", name: "High" },
			{ id: "xhigh", name: "xhigh" },
		]);
	});
});
