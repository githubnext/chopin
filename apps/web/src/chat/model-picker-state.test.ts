import { describe, expect, test } from "bun:test";

import {
	chooseLevel,
	chooseModel,
	composerModelNotice,
	defaultStepLabel,
	fallbackNotice,
	levelSteps,
	matchesQuery,
	pickerGroups,
	pickerOptions,
	reasoningLevels,
	sameChoice,
	shownModel,
	triggerLabel,
	triggerText,
	triggerTitle,
} from "./model-picker-state";

import { levelLabel } from "@chopin/protocol/model-choice";

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

// Levels a client can report side by side that used to read alike once their case was changed.
let alikeLevels = ["xhigh", "extra high", "high", "High", "\u00df-fast", "SS-fast"];
let alike: Chat.ModelCatalog = {
	models: [{ id: "acme/odd", name: "Odd", thinkingLevels: alikeLevels }],
	default: { model: "acme/odd" },
};
let asking = (thinkingLevel: string) => ({ model: "acme/odd", thinkingLevel });

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
			level: "high",
		});
		expect(triggerText(catalog, { thinkingLevel: "max" })).toEqual({ name: "Small", level: "max" });
		// A level its model does not offer is not shown.
		expect(triggerText(catalog, { model: "acme/large", thinkingLevel: "max" })).toEqual({
			name: "Large",
		});
	});

	test("gives the model, its level and what went missing as the name of the control", () => {
		expect(triggerLabel(catalog, undefined)).toBe("Model: Small");
		expect(triggerLabel(catalog, { model: "acme/large", thinkingLevel: "xhigh" })).toBe(
			"Model: Large, xhigh reasoning is no longer available for this model, so Chopin used its default.",
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

	test("shows each level exactly as it was reported, so levels that read alike stay two, in the trigger and its name", () => {
		let shown = alikeLevels.map(level => triggerText(alike, asking(level)).level);
		expect(shown).toEqual(["xhigh", "extra high", "high", "High", "\u00df-fast", "SS-fast"]);
		let named = alikeLevels.map(level => triggerLabel(alike, asking(level)));
		expect(named).toEqual([
			"Model: Odd, reasoning xhigh",
			"Model: Odd, reasoning extra high",
			"Model: Odd, reasoning high",
			"Model: Odd, reasoning High",
			"Model: Odd, reasoning \u00df-fast",
			"Model: Odd, reasoning SS-fast",
		]);
		let titles = alikeLevels.map(level => triggerTitle(alike, asking(level)));
		expect(titles).toEqual(named);
		for (let list of [shown, named, titles]) {
			expect(new Set(list).size).toBe(alikeLevels.length);
		}
	});

	test("asks for exactly the level that was picked, however it is spelled, in the order listed", () => {
		expect(reasoningLevels(alike, undefined).levels).toEqual(alikeLevels);
		for (let level of alikeLevels) {
			let asked = chooseLevel(alike, undefined, level);
			expect(asked).toEqual({ thinkingLevel: level });
			expect(reasoningLevels(alike, asked).current).toBe(level);
		}
		expect(levelSteps(alikeLevels, "High").filter(step => step.checked).map(step => step.level))
			.toEqual(["High"]);
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

describe("what the composer's strip says about the document's model", () => {
	let held = { catalog, choice: { model: "acme/large" } as Chat.ModelChoice, refusal: undefined };
	let unread = "This document's model choice couldn't be read, so Chopin used its default model.";

	test("says nothing while the choice stands, and nothing where no model can be chosen", () => {
		expect(composerModelNotice(held, false)).toBeUndefined();
		expect(composerModelNotice(undefined, false)).toBeUndefined();
	});

	test("says the choice could not be read when the server ran the default for that reason, as information", () => {
		expect(composerModelNotice(held, true)).toEqual({ tone: "info", text: unread });
		// Even where the browser holds no catalog, the strip still tells what ran.
		expect(composerModelNotice(undefined, true)).toEqual({ tone: "info", text: unread });
	});

	test("keeps what a saved choice fell back from where the harness offers no models at all", () => {
		// The picker is gone (no control, no catalog), and the choice the document holds is still said.
		let gone = "acme/large is no longer available, so Chopin used its default model.";
		expect(composerModelNotice(undefined, false, { model: "acme/large" })).toEqual({
			tone: "info",
			text: gone,
		});
		expect(composerModelNotice(undefined, false, { model: "acme/large", thinkingLevel: "high" }))
			.toEqual({ tone: "info", text: gone });
		expect(composerModelNotice(undefined, false, { thinkingLevel: "xhigh" })).toEqual({
			tone: "info",
			text: "xhigh reasoning is no longer available for this model, so Chopin used its default.",
		});
		// What could not be read still comes before it, as it does with a catalog.
		expect(composerModelNotice(undefined, true, { model: "acme/large" })).toEqual({
			tone: "info",
			text: unread,
		});
	});

	test("says nothing of a default nobody chose, or of a choice the catalog offers", () => {
		expect(composerModelNotice(undefined, false, undefined)).toBeUndefined();
		expect(composerModelNotice(undefined, false, {})).toBeUndefined();
		// With a control, its own choice is the one that counts, not the stored one beside it.
		expect(composerModelNotice(held, false, { model: "acme/gone" })).toBeUndefined();
		expect(composerModelNotice({ ...held, choice: undefined }, false, { model: "acme/large" }))
			.toBeUndefined();
	});

	test("names a saved choice before and after the picker goes away", () => {
		let text = "Large is no longer available, so Chopin used its default model.";
		let gone = { ...held, choice: { model: "acme/gone" }, modelName: "Large" };
		expect(composerModelNotice(gone, false)).toEqual({ tone: "info", text });
		expect(composerModelNotice(undefined, false, { model: "acme/gone" }, [], "Large"))
			.toEqual({ tone: "info", text });
		expect(triggerLabel(catalog, gone.choice, gone.modelName)).toBe(`Model: Small, ${text}`);
	});

	test("does not repeat a fallback already recorded in Chat, but keeps other notices", () => {
		let gone = { ...held, choice: { model: "acme/gone" } };
		let text = "acme/gone is no longer available, so Chopin used its default model.";
		let entries = [{ id: "1", author: { kind: "system" as const }, text, ts: 1 }];
		expect(composerModelNotice(gone, false, undefined, entries)).toBeUndefined();
		expect(composerModelNotice(gone, true, undefined, entries)).toEqual({
			tone: "info",
			text: unread,
		});
		expect(composerModelNotice({ ...gone, refusal: "Refused" }, false, undefined, entries))
			.toEqual({ tone: "warning", text: "Refused" });
		expect(composerModelNotice(gone, false, undefined, [])).toEqual({ tone: "info", text });
		expect(
			composerModelNotice(gone, false, undefined, [{ ...entries[0]!, text: "Another notice" }]),
		)
			.toEqual({ tone: "info", text });
		expect(
			composerModelNotice(gone, false, undefined, [{
				...entries[0]!,
				author: { kind: "member", handle: "mona" },
			}]),
		)
			.toEqual({ tone: "info", text });
	});

	test("puts a refused choice first, then what could not be read, then a model that has gone", () => {
		let refused = { ...held, refusal: "That model isn't available." };
		expect(composerModelNotice(refused, true)).toEqual({
			tone: "warning",
			text: "That model isn't available.",
		});
		let gone = { ...held, choice: { model: "acme/gone" } };
		expect(composerModelNotice(gone, false)).toEqual({
			tone: "info",
			text: "acme/gone is no longer available, so Chopin used its default model.",
		});
		expect(composerModelNotice(gone, true)).toEqual({ tone: "info", text: unread });
	});
});

describe("the reasoning control's own default beside the levels a model lists", () => {
	test("is called Default, as it always was, when no level of the model reads like it", () => {
		expect(defaultStepLabel([])).toBe("Default");
		expect(defaultStepLabel(["off", "low", "high", "xhigh"])).toBe("Default");
		// A level that only contains the word is another level.
		expect(defaultStepLabel(["default-fast", "Defaults", "undefault"])).toBe("Default");
	});

	test("says Model default instead when a level of the model would be taken for it, by any case or padding", () => {
		for (let level of ["Default", "default", "DEFAULT", " default ", "Default\t"]) {
			expect(defaultStepLabel(["low", level, "high"]), JSON.stringify(level)).toBe("Model default");
		}
	});

	test("never shares a label with a level, however the model spells them, and shows no level differently", () => {
		let crowded = ["Default", "Model default", "model default (reset)", "high"];
		let label = defaultStepLabel(crowded);
		expect(label).toBe("Model default (reset) (reset)");
		for (let levels of [[], ["Default"], ["default", "Model default"], crowded]) {
			let own = defaultStepLabel(levels);
			expect(levels.map(level => level.trim().toLowerCase())).not.toContain(own.toLowerCase());
		}
		// The levels' own labels are what the client reported, with this unchanged.
		expect(["Default", "default", "Model default"].map(level => levelLabel(level))).toEqual([
			"Default",
			"default",
			"Model default",
		]);
	});

	test("asks for the model's own level when the default is chosen, and for the level of that name when it is", () => {
		let named: Chat.ModelCatalog = {
			models: [{ id: "acme/odd", name: "Odd", thinkingLevels: ["Default", "default", "high"] }],
			default: { model: "acme/odd" },
		};
		// The step for the model's own is `undefined`; each level is the string that was listed.
		expect(levelSteps(["Default", "default", "high"], undefined).map(step => step.level)).toEqual([
			undefined,
			"Default",
			"default",
			"high",
		]);
		expect(chooseLevel(named, { thinkingLevel: "Default" }, undefined)).toEqual({});
		expect(chooseLevel(named, undefined, "Default")).toEqual({ thinkingLevel: "Default" });
		expect(chooseLevel(named, undefined, "default")).toEqual({ thinkingLevel: "default" });
		expect(triggerLabel(named, { thinkingLevel: "Default" })).toBe("Model: Odd, reasoning Default");
		expect(triggerLabel(named, {})).toBe("Model: Odd");
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

describe("a catalog that leaves fields empty", () => {
	// A client may report an empty description, list of levels, name or provider name; each is read
	// as none, and the model is still listed under what it can be called.
	let blank: Chat.ModelCatalog = {
		models: [
			{
				id: "p/one",
				name: "",
				provider: { id: "p", name: "" },
				description: "",
				thinkingLevels: [],
			},
			{ id: "p/two", name: "Two", thinkingLevels: ["low"] },
		],
		default: { model: "p/one" },
	};

	test("keeps a provider whose id is empty apart from the models that name no provider", () => {
		let mixed: Chat.ModelCatalog = {
			models: [
				{ id: "a", name: "A" },
				{ id: "b", name: "B", provider: { id: "", name: "Blank" } },
				{ id: "c", name: "C", provider: { id: "" } },
			],
		};
		let groups = pickerGroups(mixed, undefined, "");
		expect(groups.map(group => [group.name, group.models.map(model => model.id)])).toEqual([
			["Other", ["a"]],
			["Blank", ["b", "c"]],
		]);
		expect(new Set(groups.map(group => group.id)).size).toBe(2);
	});

	test("reads an empty list of levels as no reasoning control", () => {
		expect(reasoningLevels(blank, undefined)).toEqual({ levels: [], current: undefined });
		expect(reasoningLevels(blank, { model: "p/two" }).levels).toEqual(["low"]);
	});

	test("names a model by its id and a provider by its id when their names are empty", () => {
		let [group, ...others] = pickerGroups(blank, undefined, "");
		expect(others).toHaveLength(1);
		expect(group!.name).toBe("p");
		expect(group!.models.map(model => model.name)).toEqual(["p/one"]);
		expect(triggerText(blank, undefined)).toEqual({ name: "p/one" });
		expect(triggerLabel(blank, undefined)).toBe("Model: p/one");
		// A search still finds it by id, and an empty description matches nothing but adds nothing.
		expect(pickerOptions(pickerGroups(blank, undefined, "one")).map(model => model.id)).toEqual([
			"p/one",
		]);
	});
});

describe("what a pick asks for", () => {
	test("records the model chosen, the harness's own included, so the document keeps it", () => {
		expect(chooseModel(catalog, { model: "acme/large" }, "acme/small")).toEqual({
			model: "acme/small",
		});
		expect(chooseModel(catalog, undefined, "acme/small")).toEqual({ model: "acme/small" });
		expect(chooseModel(catalog, undefined, "acme/large")).toEqual({ model: "acme/large" });
	});

	test("a model chosen while it was the default stays chosen when the client's default moves", () => {
		let chosen = chooseModel(catalog, undefined, "acme/small");
		let moved = { ...catalog, default: { model: "acme/large" } };
		expect(shownModel(moved, chosen)?.id).toBe("acme/small");
		expect(triggerText(moved, chosen)).toEqual({ name: "Small" });
		expect(fallbackNotice(moved, chosen)).toBeUndefined();
		// Nobody chose: the document still follows the client's default.
		expect(shownModel(moved, undefined)?.id).toBe("acme/large");
	});

	test("keeps the level across a model that offers it and drops it across one that does not", () => {
		let high = { model: "acme/large", thinkingLevel: "high" };
		expect(chooseModel(catalog, high, "acme/small")).toEqual({
			model: "acme/small",
			thinkingLevel: "high",
		});
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

describe("a catalog that repeats an id or a level", () => {
	// All of it is valid on the wire, and Chopin keeps it as the client wrote it.
	let repeated: Chat.ModelCatalog = {
		models: [
			{
				id: "acme/a",
				name: "A, first",
				provider: { id: "acme", name: "Acme" },
				thinkingLevels: ["high", "off", "high", "default"],
			},
			{ id: "beta/b", name: "B", provider: { id: "beta", name: "Beta" } },
			{ id: "acme/a", name: "A, again", provider: { id: "acme", name: "Acme" } },
			{ id: "acme/a", name: "A, third" },
		],
		default: { model: "acme/a" },
	};

	test("lists every entry in the catalog's order and tells each apart", () => {
		let flat = pickerOptions(pickerGroups(repeated, undefined, ""));
		expect(flat.map(model => model.name)).toEqual(["A, first", "A, again", "B", "A, third"]);
		expect(new Set(flat.map(model => model.key)).size).toBe(flat.length);
	});

	test("selects only the first entry of the id that will run", () => {
		let flat = (choice?: Chat.ModelChoice) => pickerOptions(pickerGroups(repeated, choice, ""));
		expect(flat().filter(model => model.selected).map(model => model.name)).toEqual(["A, first"]);
		expect(flat({ model: "beta/b" }).filter(model => model.selected).map(model => model.name))
			.toEqual(["B"]);
	});

	test("keeps an entry's key while a search removes the others", () => {
		let key = (query: string, name: string) =>
			pickerOptions(pickerGroups(repeated, undefined, query)).find(model => model.name === name)
				?.key;
		expect(key("again", "A, again")).toBeDefined();
		expect(key("again", "A, again")).toBe(key("", "A, again"));
		expect(key("third", "A, third")).toBe(key("", "A, third"));
	});

	test("steps through Default and every level once, checking the first that is the choice", () => {
		let steps = levelSteps(["high", "off", "high", "default"], "high");
		expect(steps.map(step => step.level)).toEqual([undefined, "high", "off", "high", "default"]);
		expect(new Set(steps.map(step => step.key)).size).toBe(steps.length);
		expect(steps.map(step => step.checked)).toEqual([false, true, false, false, false]);
	});

	test("takes a level named default for a level, and Default for the model's own", () => {
		let levels = ["off", "default"];
		expect(levelSteps(levels, undefined).map(step => step.checked)).toEqual([true, false, false]);
		expect(levelSteps(levels, "default").map(step => step.checked)).toEqual([false, false, true]);
		expect(levelSteps(levels, "default").map(step => step.key)).toEqual(
			levelSteps(levels, undefined).map(step => step.key),
		);
		expect(new Set(levelSteps(levels, undefined).map(step => step.key)).size).toBe(3);
	});
});
