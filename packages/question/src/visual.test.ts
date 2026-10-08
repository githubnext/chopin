import { expect, test } from "bun:test";
import * as Visual from "./visual";
import type { VisualDecision } from "@chopin/protocol";

let definition: VisualDecision.Definition = {
	specimen: "decision-card-v1",
	bundleDigest: `sha256:${"a".repeat(64)}`,
	baseline: { optionPadding: 6, selectedColor: "#E1ECEF" },
	controls: [
		{ id: "optionPadding", type: "number", min: 4, max: 8, step: 2 },
		{ id: "selectedColor", type: "color", format: "#RRGGBB" },
	],
};

test("visual controls reject unknown, out-of-step and malformed values", () => {
	expect(Visual.definition(definition)).toEqual(definition);
	for (let patch of [{ optionPadding: 5 }, { selectedColor: "red" }, { code: "x" }, {}]) {
		expect(() => Visual.patch(patch)).toThrow();
	}
	expect(Visual.patch({ selectedColor: "#aabbcc" })).toEqual({ selectedColor: "#AABBCC" });
});

test("last accepted per-control values preserve independently edited controls", () => {
	let baseline = Visual.values(definition.baseline);
	let first = Visual.apply(baseline, { optionPadding: 8 });
	let second = Visual.apply(first, { selectedColor: "#112233" });
	let third = Visual.apply(second, { optionPadding: 4 });
	expect(third).toEqual({ optionPadding: 4, selectedColor: "#112233" });
	expect(baseline).toEqual(definition.baseline);
});

test("restoration accepts PostgreSQL JSONB property ordering without relaxing control schema", () => {
	let reordered = {
		...definition,
		controls: [
			{ max: 8, min: 4, id: "optionPadding", step: 2, type: "number" },
			{ format: "#RRGGBB", type: "color", id: "selectedColor" },
		],
	};
	expect(Visual.definition(reordered)).toEqual(definition);
	expect(() =>
		Visual.definition({
			...definition,
			controls: [
				{ ...definition.controls[0], unsupported: true },
				definition.controls[1],
			],
		})
	).toThrow();
});

test("restored saved values must match the captured draft revision and values", () => {
	let state: VisualDecision.State = {
		id: "visual-1",
		definition,
		revision: 2,
		values: { optionPadding: 8, selectedColor: "#123456" },
		saved: {
			revision: 2,
			values: { optionPadding: 8, selectedColor: "#123456" },
			by: "ana",
			at: "2026-10-08T12:00:00.000Z",
		},
	};
	expect(Visual.state(state)).toEqual(state);
	expect(() => Visual.state({ ...state, saved: { ...state.saved, revision: 1 } })).toThrow();
	expect(() => Visual.state({ ...state, saved: { ...state.saved, values: definition.baseline } }))
		.toThrow();
});
