import { describe, expect, it } from "bun:test";

import { atomicThinkingLevels, remoteCatalog } from "./catalog";

describe("the thinking levels Atomic offers a model", () => {
	it("offers none for a model that does not reason", () => {
		expect(atomicThinkingLevels({ reasoning: false })).toEqual([]);
	});

	it("lists the five ordinary levels, and xhigh and max only where the model maps them", () => {
		expect(atomicThinkingLevels({ reasoning: true })).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect(atomicThinkingLevels({
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		})).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(atomicThinkingLevels({ reasoning: true, thinkingLevelMap: { max: "max" } }))
			.toEqual(["off", "minimal", "low", "medium", "high", "max"]);
	});

	it("drops a level the model maps to null", () => {
		expect(atomicThinkingLevels({
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" },
		})).toEqual(["low", "medium", "high", "xhigh"]);
	});
});

describe("the catalog of a remote Planner", () => {
	let reported = {
		models: {
			available: [
				{
					id: "acme/large",
					name: "Large",
					provider: { id: "acme", name: "Acme" },
					description: "Careful.",
					thinkingLevels: ["low", "high"],
				},
				{ id: "acme/small", name: "Small", thinkingLevels: [] },
			],
			default: { id: "acme/small", thinkingLevel: "low" },
		},
	};

	it("is none for a client that reported nothing, or no models", () => {
		expect(remoteCatalog(undefined, undefined)).toBeUndefined();
		expect(remoteCatalog({}, undefined)).toBeUndefined();
		expect(remoteCatalog({ commands: [{ name: "notes", kind: "skill" }] }, undefined))
			.toBeUndefined();
		expect(remoteCatalog({ models: { available: [] } }, undefined)).toBeUndefined();
	});

	it("passes the models through in the order, spelling and duplicates the client gave", () => {
		let twice = {
			models: {
				available: [
					{ id: "b", name: "B" },
					{ id: "a", name: "A" },
					{ id: "b", name: "B again" },
				],
			},
		};
		expect(remoteCatalog(twice, undefined)!.models.map(model => model.name)).toEqual([
			"B",
			"A",
			"B again",
		]);
	});

	it("leaves out empty level lists and carries the client's default", () => {
		let catalog = remoteCatalog(reported, undefined)!;
		expect(catalog.models[0]).toEqual({
			id: "acme/large",
			name: "Large",
			provider: { id: "acme", name: "Acme" },
			description: "Careful.",
			thinkingLevels: ["low", "high"],
		});
		expect(catalog.models[1]).toEqual({ id: "acme/small", name: "Small" });
		expect(catalog.default).toEqual({ model: "acme/small", thinkingLevel: "low" });
	});

	it("takes the operator's MODEL as the default in the client's place, with the client's level dropped", () => {
		expect(remoteCatalog(reported, "acme/large")!.default).toEqual({ model: "acme/large" });
	});

	it("has no default when neither names one", () => {
		let { default: _, ...models } = reported.models;
		expect(remoteCatalog({ models }, undefined)!.default).toBeUndefined();
	});
});
