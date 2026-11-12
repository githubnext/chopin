import { describe, expect, it } from "bun:test";

import { modelOptions, modelSelection } from "./model-options";

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

describe("what the composer's model pill gives the copied selector", () => {
	let catalog = {
		models: [
			{
				id: "gpt-5",
				name: "GPT-5",
				provider: { id: "openai", name: "OpenAI" },
				thinkingLevels: ["low", "high"],
			},
			{
				id: "mini",
				name: "Mini",
				provider: { id: "openai", name: "OpenAI" },
				description: "Quick",
			},
			{ id: "sonnet", name: "Sonnet", provider: { id: "anthropic", name: "Anthropic" } },
		],
		default: { model: "mini" },
	};

	it("groups the models by provider and selects the one the agent runs when nobody has chosen, its description as reported", () => {
		let { groups, value } = modelSelection(catalog, undefined);
		expect(groups.map(group => group.name)).toEqual(["OpenAI", "Anthropic"]);
		expect(groups[0]!.options.map(option => option.name)).toEqual(["GPT-5", "Mini"]);
		expect(value).toBe(groups[0]!.options[1]!.id);
		expect(groups[0]!.options[1]!.description).toBe("Quick");
	});

	it("lets a search find a model by its id, provider or description, beside its name", () => {
		let { groups } = modelSelection(catalog, undefined);
		expect(groups[0]!.options[1]!.keywords).toEqual(["mini", "OpenAI", "openai", "Quick"]);
	});

	it("keeps a model listed twice as two, told apart by place, and picks back the id a turn carries", () => {
		let { groups, modelOf } = modelSelection(
			{ models: [{ id: "m", name: "M" }, { id: "m", name: "M again" }] },
			{ model: "m" },
		);
		let [first, second] = groups[0]!.options;
		expect(first!.id).not.toBe(second!.id);
		expect([modelOf(first!.id), modelOf(second!.id)]).toEqual(["m", "m"]);
	});

	it("offers each level as the harness spelled it, and nothing else", () => {
		let { groups, effort, levelOf } = modelSelection(catalog, {
			model: "gpt-5",
			thinkingLevel: "high",
		});
		let efforts = groups[0]!.options[0]!.efforts as { id: string; name: string }[];
		expect(efforts.map(step => step.name)).toEqual(["low", "high"]);
		expect(levelOf(effort!)).toBe("high");
		expect(levelOf(efforts[0]!.id)).toBe("low");
		expect(levelOf("9")).toBeUndefined();
	});

	it("lists a level called Default as the level it is", () => {
		let { groups } = modelSelection(
			{ models: [{ id: "m", name: "M", thinkingLevels: ["Default", "high"] }] },
			undefined,
		);
		let efforts = groups[0]!.options[0]!.efforts as { id: string; name: string }[];
		expect(efforts.map(step => step.name)).toEqual(["Default", "high"]);
	});

	it("selects the agent's own level while nobody chose one, and none where it is not known", () => {
		let levelled = { ...catalog, default: { model: "gpt-5", thinkingLevel: "high" } };
		let own = modelSelection(levelled, undefined);
		expect(own.levelOf(own.effort!)).toBe("high");
		expect(modelSelection(catalog, { model: "gpt-5" }).effort).toBeUndefined();
	});

	it("selects the first of two levels that read alike only when it is the one chosen", () => {
		let catalog = { models: [{ id: "m", name: "M", thinkingLevels: ["high", "High"] }] };
		let high = modelSelection(catalog, { model: "m", thinkingLevel: "High" });
		expect(high.levelOf(high.effort!)).toBe("High");
		let first = modelSelection(catalog, { model: "m", thinkingLevel: "high" });
		expect(first.levelOf(first.effort!)).toBe("high");
	});

	it("selects nothing where no model is chosen and the harness names no default, and offers no levels", () => {
		let { value, effort, groups } = modelSelection({ models: [{ id: "a", name: "A" }] }, undefined);
		expect(value).toBe("");
		expect(effort).toBeUndefined();
		expect(groups[0]!.name).toBeUndefined();
	});
});
