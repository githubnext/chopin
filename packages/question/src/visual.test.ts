import { expect, test } from "bun:test";
import type { VisualDecision } from "@chopin/protocol";
import * as Visual from "./visual";

let definition: VisualDecision.Definition = {
	schema: "visual-decision@1",
	title: "Navigation spacing",
	requestId: "request-one",
	artifact: { ref: "navigation-preview", digest: `sha256:${"a".repeat(64)}` },
	definitionRevision: `sha256:${"b".repeat(64)}`,
	controls: [
		{ type: "number", id: "rowGap", label: "Row gap", unit: "px", min: 2, max: 14, step: 3 },
		{ type: "color", id: "accent", label: "Accent" },
	],
	baseline: { rowGap: 8, accent: "#E1ECEF" },
};

test("generic definitions require bounded named controls and complete baseline", () => {
	expect(Visual.definition(definition)).toEqual(definition);
	expect(() => Visual.definition({ ...definition, controls: [] })).toThrow();
	expect(() => Visual.definition({ ...definition, baseline: { rowGap: 8 } })).toThrow();
	expect(() =>
		Visual.definition({
			...definition,
			controls: [...definition.controls, { type: "color", id: "accent", label: "Duplicate" }],
		})
	).toThrow();
	expect(() =>
		Visual.definition({
			...definition,
			artifact: { ref: "https://example.com/preview", digest: definition.artifact.digest },
		})
	).toThrow();
});

test("generic patches keep independent controls and use a min-relative step grid", () => {
	let first = Visual.apply(definition, definition.baseline, { rowGap: 14 });
	let second = Visual.apply(definition, first, { accent: "#aabbcc" });
	expect(second).toEqual({ rowGap: 14, accent: "#AABBCC" });
	for (let patch of [{ rowGap: 12 }, { accent: "red" }, { unknown: 1 }, {}]) {
		expect(() => Visual.patch(definition, patch)).toThrow();
	}
});

test("saved records bind the exact definition, artifact, draft and values", () => {
	let state: VisualDecision.State = {
		id: "decision-one",
		definition,
		revision: 2,
		values: { rowGap: 14, accent: "#123456" },
		saved: {
			decisionId: "decision-one",
			requestId: definition.requestId,
			definitionRevision: definition.definitionRevision,
			artifactDigest: definition.artifact.digest,
			revision: 2,
			values: { rowGap: 14, accent: "#123456" },
			by: "ana",
			at: "2026-10-08T12:00:00.000Z",
		},
	};
	expect(Visual.state(state)).toEqual(state);
	for (
		let change of [
			{ revision: 1 },
			{ definitionRevision: `sha256:${"c".repeat(64)}` },
			{ artifactDigest: `sha256:${"c".repeat(64)}` },
			{ values: definition.baseline },
		]
	) expect(() => Visual.state({ ...state, saved: { ...state.saved, ...change } })).toThrow();
});
