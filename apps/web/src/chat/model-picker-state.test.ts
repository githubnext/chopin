import { describe, expect, test } from "bun:test";

import {
	chooseLevel,
	chooseModel,
	fallbackNotice,
	matchesQuery,
	movedIndex,
	pickerGroups,
	pickerKey,
	pickerOptions,
	reasoningLevels,
	sameChoice,
	shownModel,
	triggerLabel,
	triggerText,
	triggerTitle,
} from "./model-picker-state";

import type { Chat } from "@chopin/protocol";

let catalog: Chat.ModelCatalog = {
	models: [
		{
			id: "acme/large",
			name: "Large",
			provider: { id: "acme", name: "Acme" },
			description: "Slower and more careful.",
			thinkingLevels: ["off", "low", "high"],
		},
		{ id: "beta/mini", name: "Mini", provider: { id: "beta" }, description: "Quick answers." },
		{
			id: "acme/small",
			name: "Small",
			provider: { id: "acme", name: "Acme" },
			thinkingLevels: ["low", "high", "max"],
		},
	],
	default: { model: "acme/small" },
};

describe("what the picker lists", () => {
	test("groups by provider in the order each first appears, keeping the catalog's order inside one", () => {
		let groups = pickerGroups(catalog, undefined, "");
		expect(groups.map(group => [group.name, group.models.map(model => model.id)])).toEqual([
			["Acme", ["acme/large", "acme/small"]],
			["beta", ["beta/mini"]],
		]);
		expect(pickerOptions(groups).map(model => model.id)).toEqual([
			"acme/large",
			"acme/small",
			"beta/mini",
		]);
	});

	test("marks the harness's own model, and the one that will run", () => {
		let flat = (choice?: Chat.ModelChoice) => pickerOptions(pickerGroups(catalog, choice, ""));
		expect(flat().map(model => [model.id, model.isDefault, model.selected])).toEqual([
			["acme/large", false, false],
			["acme/small", true, true],
			["beta/mini", false, false],
		]);
		expect(flat({ model: "beta/mini" }).filter(model => model.selected).map(model => model.id))
			.toEqual(["beta/mini"]);
		// A model that has gone leaves the default selected, as the server will run it.
		expect(flat({ model: "acme/gone" }).filter(model => model.selected).map(model => model.id))
			.toEqual(["acme/small"]);
	});

	test("lists no heading when no model names a provider, and Other beside providers that do", () => {
		let plain: Chat.ModelCatalog = { models: [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
		expect(pickerGroups(plain, undefined, "").map(group => group.name)).toEqual([undefined]);
		let mixed: Chat.ModelCatalog = {
			models: [{ id: "a", name: "A" }, { id: "b", name: "B", provider: { id: "p" } }],
		};
		expect(pickerGroups(mixed, undefined, "").map(group => group.name)).toEqual(["Other", "p"]);
	});

	test("finds a model by any term in its name, id, provider or description, in any case", () => {
		let found = (query: string) =>
			pickerOptions(pickerGroups(catalog, undefined, query)).map(model => model.id);
		expect(found("")).toHaveLength(3);
		expect(found("LARGE")).toEqual(["acme/large"]);
		expect(found("beta")).toEqual(["beta/mini"]);
		expect(found("acme careful")).toEqual(["acme/large"]);
		expect(found("quick")).toEqual(["beta/mini"]);
		expect(found("  acme  ")).toEqual(["acme/large", "acme/small"]);
		expect(found("nothing like it")).toEqual([]);
		expect(pickerGroups(catalog, undefined, "nothing")).toEqual([]);
		expect(matchesQuery(catalog.models[0]!, "acme/large")).toBe(true);
	});
});

describe("what the trigger says", () => {
	test("names the default model until somebody chooses, and says Default when the harness names none", () => {
		expect(triggerText(catalog, undefined)).toEqual({ name: "Small" });
		expect(triggerText({ models: catalog.models }, undefined)).toEqual({ name: "Default" });
		expect(shownModel({ models: catalog.models }, undefined)).toBeUndefined();
	});

	test("adds the level only when one was chosen for the model", () => {
		expect(triggerText(catalog, { model: "acme/large", thinkingLevel: "high" })).toEqual({
			name: "Large",
			level: "High",
		});
		expect(triggerText(catalog, { thinkingLevel: "max" })).toEqual({ name: "Small", level: "Max" });
		// A level its model does not offer is not shown.
		expect(triggerText(catalog, { model: "acme/large", thinkingLevel: "max" })).toEqual({
			name: "Large",
		});
	});

	test("gives the model, its level and what went missing as the name of the control", () => {
		expect(triggerLabel(catalog, undefined)).toBe("Model: Small");
		expect(triggerLabel(catalog, { model: "acme/large", thinkingLevel: "xhigh" })).toBe(
			"Model: Large, Extra high reasoning is no longer available for this model, so Chopin used its default.",
		);
	});

	test("keeps the tooltip to the model and level, though the name also says what went missing", () => {
		expect(triggerTitle(catalog, undefined)).toBe("Model: Small");
		expect(triggerTitle(catalog, { model: "acme/large", thinkingLevel: "high" })).toBe(
			"Model: Large, reasoning high",
		);
		expect(triggerTitle(catalog, { model: "acme/gone", thinkingLevel: "high" })).toBe(
			"Model: Small",
		);
		expect(triggerLabel(catalog, { model: "acme/gone" })).toContain("no longer available");
	});

	test("says what a gone model fell back to, and nothing when the choice stands", () => {
		expect(fallbackNotice(catalog, { model: "acme/gone" })).toBe(
			"acme/gone is no longer available, so Chopin used its default model.",
		);
		expect(triggerLabel(catalog, { model: "acme/gone" })).toBe(
			"Model: Small, acme/gone is no longer available, so Chopin used its default model.",
		);
		expect(fallbackNotice(catalog, { model: "acme/large", thinkingLevel: "low" })).toBeUndefined();
		expect(fallbackNotice(catalog, undefined)).toBeUndefined();
	});
});

describe("the reasoning control", () => {
	test("offers the levels of the model that will run, and hides for a model that has none", () => {
		expect(reasoningLevels(catalog, { model: "acme/large" })).toEqual({
			levels: ["off", "low", "high"],
			current: undefined,
		});
		expect(reasoningLevels(catalog, undefined).levels).toEqual(["low", "high", "max"]);
		expect(reasoningLevels(catalog, { model: "beta/mini" }).levels).toEqual([]);
		// A gone model has no levels of its own: the default's are offered.
		expect(reasoningLevels(catalog, { model: "acme/gone" }).levels).toEqual(["low", "high", "max"]);
	});
});

describe("what a pick asks for", () => {
	test("choosing the harness's own model clears the model instead of pinning it", () => {
		expect(chooseModel(catalog, { model: "acme/large" }, "acme/small")).toEqual({});
		expect(chooseModel(catalog, undefined, "acme/large")).toEqual({ model: "acme/large" });
	});

	test("keeps the level across a model that offers it and drops it across one that does not", () => {
		let high = { model: "acme/large", thinkingLevel: "high" };
		expect(chooseModel(catalog, high, "acme/small")).toEqual({ thinkingLevel: "high" });
		expect(chooseModel(catalog, { model: "acme/small", thinkingLevel: "max" }, "acme/large"))
			.toEqual({ model: "acme/large" });
		expect(chooseModel(catalog, high, "beta/mini")).toEqual({ model: "beta/mini" });
	});

	test("never carries a gone model's level, or the gone model, into a new choice", () => {
		let gone = { model: "acme/gone", thinkingLevel: "high" };
		expect(chooseModel(catalog, gone, "beta/mini")).toEqual({ model: "beta/mini" });
		expect(chooseLevel(catalog, gone, "low")).toEqual({ thinkingLevel: "low" });
	});

	test("a level keeps the chosen model, and no level goes back to the model's own", () => {
		expect(chooseLevel(catalog, { model: "acme/large" }, "off")).toEqual({
			model: "acme/large",
			thinkingLevel: "off",
		});
		expect(chooseLevel(catalog, { model: "acme/large", thinkingLevel: "off" }, undefined)).toEqual({
			model: "acme/large",
		});
		expect(chooseLevel(catalog, undefined, "low")).toEqual({ thinkingLevel: "low" });
	});

	test("compares choices field by field", () => {
		expect(sameChoice(undefined, {})).toBe(true);
		expect(sameChoice({ model: "a" }, { model: "a" })).toBe(true);
		expect(sameChoice({ model: "a" }, { model: "a", thinkingLevel: "low" })).toBe(false);
		expect(sameChoice({ model: "a" }, undefined)).toBe(false);
	});
});

describe("the keyboard", () => {
	let key = (name: string, extra: object = {}) => pickerKey({ key: name, ...extra }, true);

	test("moves, picks and closes, and leaves every other key to the search field", () => {
		expect(key("ArrowDown")).toBe("next");
		expect(key("ArrowUp")).toBe("previous");
		expect(key("Enter")).toBe("pick");
		expect(key("Escape")).toBe("close");
		for (let other of ["Home", "End", "a", "Tab", "ArrowLeft", "ArrowRight"]) {
			expect(key(other)).toBeUndefined();
		}
		expect(key("Enter", { shiftKey: true })).toBeUndefined();
	});

	test("does nothing mid-composition, and only closes when there is nothing to pick", () => {
		expect(key("Enter", { isComposing: true })).toBeUndefined();
		expect(key("Escape", { keyCode: 229 })).toBeUndefined();
		expect(pickerKey({ key: "ArrowDown" }, false)).toBeUndefined();
		expect(pickerKey({ key: "Enter" }, false)).toBeUndefined();
		expect(pickerKey({ key: "Escape" }, false)).toBe("close");
	});

	test("wraps at either end and stays put when empty", () => {
		expect(movedIndex("next", 2, 3)).toBe(0);
		expect(movedIndex("previous", 0, 3)).toBe(2);
		expect(movedIndex("next", 0, 3)).toBe(1);
		expect(movedIndex("next", 0, 0)).toBe(0);
		expect(movedIndex("pick", 1, 3)).toBe(1);
	});
});
