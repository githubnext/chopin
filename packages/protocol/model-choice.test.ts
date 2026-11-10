import { describe, expect, it } from "bun:test";

import {
	levelLabel,
	modelLevels,
	refusedChoice,
	resolveChoice,
	unavailableNotice,
} from "./model-choice";

import type { Chat } from "./chat";

let catalog: Chat.ModelCatalog = {
	models: [
		{ id: "acme/large", name: "Large", thinkingLevels: ["off", "low", "high"] },
		{ id: "acme/small", name: "Small" },
		{ id: "acme/plain", name: "Plain", thinkingLevels: [] },
	],
	default: { model: "acme/small" },
};

describe("a document's model choice resolved against the catalog", () => {
	it("runs the default when nobody has chosen", () => {
		expect(resolveChoice(catalog, undefined)).toEqual({});
		expect(resolveChoice(catalog, {})).toEqual({});
		expect(resolveChoice(undefined, undefined)).toEqual({});
		expect(resolveChoice(undefined, {})).toEqual({});
	});

	it("honours a model and a level the catalog offers, exactly as stored", () => {
		expect(resolveChoice(catalog, { model: "acme/large", thinkingLevel: "high" })).toEqual({
			model: "acme/large",
			thinkingLevel: "high",
		});
		expect(resolveChoice(catalog, { model: "acme/large" })).toEqual({ model: "acme/large" });
	});

	it("takes a level for the default model when only a level is chosen", () => {
		let withLevels: Chat.ModelCatalog = {
			models: [{ id: "acme/small", name: "Small", thinkingLevels: ["low", "max"] }],
			default: { model: "acme/small" },
		};
		expect(resolveChoice(withLevels, { thinkingLevel: "max" })).toEqual({ thinkingLevel: "max" });
		expect(resolveChoice(catalog, { thinkingLevel: "high" })).toEqual({
			unavailable: { thinkingLevel: "high" },
		});
	});

	it("drops a model that has gone, with the level that belonged to it, and says so", () => {
		expect(resolveChoice(catalog, { model: "acme/old", thinkingLevel: "high" })).toEqual({
			unavailable: { model: "acme/old", thinkingLevel: "high" },
		});
	});

	it("keeps the model and drops only a level it no longer offers", () => {
		expect(resolveChoice(catalog, { model: "acme/large", thinkingLevel: "xhigh" })).toEqual({
			model: "acme/large",
			unavailable: { thinkingLevel: "xhigh" },
		});
		expect(resolveChoice(catalog, { model: "acme/plain", thinkingLevel: "low" })).toEqual({
			model: "acme/plain",
			unavailable: { thinkingLevel: "low" },
		});
	});

	it("honours nothing without a catalog, and keeps what was stored in `unavailable`", () => {
		expect(resolveChoice(undefined, { model: "acme/large", thinkingLevel: "low" })).toEqual({
			unavailable: { model: "acme/large", thinkingLevel: "low" },
		});
	});

	it("matches ids exactly: case, spacing and duplicates are the harness's own", () => {
		expect(resolveChoice(catalog, { model: "ACME/LARGE" })).toEqual({
			unavailable: { model: "ACME/LARGE" },
		});
		let twice: Chat.ModelCatalog = {
			models: [
				{ id: "a", name: "First", thinkingLevels: ["low"] },
				{ id: "a", name: "Second", thinkingLevels: ["high"] },
			],
		};
		expect(modelLevels(twice, "a")).toEqual(["low"]);
	});

	it("reports the levels of the chosen model, or of the default model when none is chosen", () => {
		expect(modelLevels(catalog, "acme/large")).toEqual(["off", "low", "high"]);
		expect(modelLevels(catalog, undefined)).toEqual([]);
		expect(modelLevels(catalog, "acme/missing")).toEqual([]);
		expect(modelLevels(undefined, "acme/large")).toEqual([]);
	});
});

describe("refusing a choice the catalog does not offer", () => {
	it("accepts the empty choice and any choice the catalog offers", () => {
		expect(refusedChoice(undefined, {})).toBeUndefined();
		expect(refusedChoice(catalog, {})).toBeUndefined();
		expect(refusedChoice(catalog, { model: "acme/large", thinkingLevel: "off" })).toBeUndefined();
	});

	it("says what is missing, in plain words", () => {
		expect(refusedChoice(undefined, { model: "acme/large" })).toBe(
			"This document's model can't be chosen.",
		);
		expect(refusedChoice(catalog, { model: "acme/old" })).toBe("That model isn't available.");
		expect(refusedChoice(catalog, { model: "acme/large", thinkingLevel: "max" })).toBe(
			"That model doesn't offer that level of reasoning.",
		);
		expect(refusedChoice(catalog, { thinkingLevel: "low" })).toBe(
			"That model doesn't offer that level of reasoning.",
		);
	});
});

describe("the words for a level and for a choice that could not be honoured", () => {
	it("spells Atomic's levels in sentence case and keeps any other as its client wrote it", () => {
		expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(levelLabel)).toEqual([
			"Off",
			"Minimal",
			"Low",
			"Medium",
			"High",
			"Extra high",
			"Max",
		]);
		expect(levelLabel("balanced")).toBe("Balanced");
		expect(levelLabel("Deep-think")).toBe("Deep-think");
	});

	it("reads any string a client names a level as that string, even one an object already has", () => {
		expect(
			["constructor", "toString", "__proto__", "hasOwnProperty", "extra high", "\u4f4e", ""]
				.map(levelLabel),
		).toEqual([
			"Constructor",
			"ToString",
			"__proto__",
			"HasOwnProperty",
			"Extra high",
			"\u4f4e",
			"",
		]);
	});

	it("names a model whose catalog name is empty by its id", () => {
		let blank = { models: [{ id: "acme/blank", name: "" }] };
		expect(unavailableNotice(blank, { model: "acme/blank" })).toBe(
			"acme/blank is no longer available, so Chopin used its default model.",
		);
	});

	it("names the model by its catalog name, or by its id when the catalog no longer lists it", () => {
		expect(unavailableNotice(catalog, { model: "acme/large" })).toBe(
			"Large is no longer available, so Chopin used its default model.",
		);
		expect(unavailableNotice(catalog, { model: "acme/old" })).toBe(
			"acme/old is no longer available, so Chopin used its default model.",
		);
		expect(unavailableNotice(catalog, { thinkingLevel: "xhigh" })).toBe(
			"Extra high reasoning is no longer available for this model, so Chopin used its default.",
		);
	});
});
