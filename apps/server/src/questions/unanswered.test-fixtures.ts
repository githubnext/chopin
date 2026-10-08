import type { JsonValue } from "../storage/model";

function definition(...ids: string[]): JsonValue {
	return {
		questions: ids.map(id => ({
			id,
			header: id,
			question: `Choose ${id}`,
			multiple: false,
			options: [{ id: `${id}-option`, label: "Option", description: "" }],
		})),
	};
}

export const UNANSWERED_SIDECARS: Array<{ name: string; sidecar: JsonValue; expected: number }> = [
	{
		name: "counts open and reopened cards but not settled ones",
		sidecar: {
			questions: [
				{ id: "open", status: "open", definition: definition("a") },
				{ id: "reopened", status: "reopened", definition: definition("b"), answers: { b: "x" } },
				{ id: "answered", status: "answered", definition: definition("c"), answers: { c: "x" } },
				{ id: "discarded", status: "discarded", definition: definition("d") },
				{ id: "cancelled", status: "cancelled", definition: definition("e") },
				{ id: "expired", status: "expired", definition: definition("f") },
			],
		},
		expected: 2,
	},
	{
		name: "counts only the unanswered questions of an open questionnaire",
		sidecar: {
			questions: [{
				id: "legacy",
				status: "open",
				definition: definition("first", "second", "third"),
				answers: { second: "Chosen" },
			}],
		},
		expected: 2,
	},
	{
		name: "counts every question of a reopened questionnaire",
		sidecar: {
			questions: [{
				id: "reopened",
				status: "reopened",
				definition: definition("first", "second"),
				answers: { first: "Before", second: "Before" },
			}],
		},
		expected: 2,
	},
	{
		name: "treats malformed answers as unanswered",
		sidecar: {
			questions: [{ id: "odd", status: "open", definition: definition("a", "b"), answers: ["a"] }],
		},
		expected: 2,
	},
	{
		name: "ignores records without a question list",
		sidecar: {
			questions: [
				{ id: "missing", status: "open" },
				{ id: "scalar", status: "open", definition: { questions: "a" } },
				"not a record",
				null,
			],
		},
		expected: 0,
	},
	{ name: "reads an empty sidecar as zero", sidecar: null, expected: 0 },
	{ name: "reads a sidecar without records as zero", sidecar: { version: 1 }, expected: 0 },
	{ name: "reads a non-list question field as zero", sidecar: { questions: {} }, expected: 0 },
];
