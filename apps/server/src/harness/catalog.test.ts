import { describe, expect, it } from "bun:test";

import { atomicThinkingLevels, remoteCatalog, remoteCommands } from "./catalog";

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

	it("keeps the fields the client reported, an empty description or level list included, and carries its default", () => {
		let catalog = remoteCatalog(reported, undefined)!;
		expect(catalog.models[0]).toEqual({
			id: "acme/large",
			name: "Large",
			provider: { id: "acme", name: "Acme" },
			description: "Careful.",
			thinkingLevels: ["low", "high"],
		});
		// An empty list is what the client said: no levels, which the composer reads as no control.
		expect(catalog.models[1]).toEqual({ id: "acme/small", name: "Small", thinkingLevels: [] });
		expect(catalog.default).toEqual({ model: "acme/small", thinkingLevel: "low" });
		let blank = remoteCatalog({
			models: {
				available: [
					{
						id: "a",
						name: "A",
						description: "",
						thinkingLevels: [],
						provider: { id: "p", name: "" },
					},
					{ id: "b", name: "B" },
				],
			},
		}, undefined)!;
		expect(blank.models).toEqual([
			{ id: "a", name: "A", description: "", thinkingLevels: [], provider: { id: "p", name: "" } },
			{ id: "b", name: "B" },
		]);
	});

	it("lists every model a client reports, and shows the room only what the picker uses", () => {
		// A report may carry what Chopin has no use for yet, and more models than any one person picks from.
		let many = {
			models: {
				available: Array.from({ length: 710 }, (_, index) => ({
					id: `p/m${index}`,
					name: `M ${index}`,
					provider: { id: "p", homepage: "https://example.test" },
					price: { input: 1 },
				})),
			},
			attachments: { images: true },
		};
		let catalog = remoteCatalog(many, undefined)!;
		expect(catalog.models).toHaveLength(710);
		expect(catalog.models[709]).toEqual({ id: "p/m709", name: "M 709", provider: { id: "p" } });
	});

	it("tells the room what each model reads, as the client reported it, and nothing where it did not", () => {
		let catalog = remoteCatalog({
			models: {
				available: [
					{ id: "a", name: "A", inputTypes: ["text", "image"] },
					{ id: "b", name: "B", inputTypes: [] },
					{ id: "c", name: "C" },
				],
			},
		}, undefined)!;
		expect(catalog.models).toEqual([
			{ id: "a", name: "A", inputTypes: ["text", "image"] },
			{ id: "b", name: "B", inputTypes: [] },
			{ id: "c", name: "C" },
		]);
	});

	it("carries a default the client spelled with empty strings as it did", () => {
		let catalog = remoteCatalog({
			models: { available: [{ id: "", name: "" }], default: { id: "", thinkingLevel: "" } },
		}, undefined)!;
		expect(catalog.default).toEqual({ model: "", thinkingLevel: "" });
	});

	it("takes the operator's MODEL as the default in the client's place, with the client's level dropped", () => {
		expect(remoteCatalog(reported, "acme/large")!.default).toEqual({ model: "acme/large" });
	});

	it("has no default when neither names one", () => {
		let { default: _, ...models } = reported.models;
		expect(remoteCatalog({ models }, undefined)!.default).toBeUndefined();
	});
});

describe("the commands of a remote Planner", () => {
	it("are none for a client that reported none", () => {
		expect(remoteCommands(undefined)).toBeUndefined();
		expect(remoteCommands({})).toBeUndefined();
		expect(remoteCommands({ models: { available: [] } })).toBeUndefined();
		expect(remoteCommands({ commands: [] })).toBeUndefined();
	});

	it("keep the order, spelling, duplicates and kinds the client gave, and leave a missing description out", () => {
		expect(remoteCommands({
			commands: [
				{ name: "Review", kind: "prompt", description: "" },
				{ name: "skill:x", kind: "skill" },
				{ name: "Review", kind: "prompt", description: "again" },
				{ name: "ship", kind: "Pipeline" },
				{ name: "", kind: "workflow" },
			],
		})).toEqual([
			{ name: "Review", kind: "prompt", description: "" },
			{ name: "skill:x", kind: "skill" },
			{ name: "Review", kind: "prompt", description: "again" },
			{ name: "ship", kind: "Pipeline" },
			{ name: "", kind: "workflow" },
		]);
	});
});
