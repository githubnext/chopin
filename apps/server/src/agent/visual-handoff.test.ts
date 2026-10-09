import { expect, test } from "bun:test";

import { visualCandidate, visualWrite } from "./visual-handoff";

test("extracts one explanatory paragraph and its stable operation target", () => {
	expect(visualCandidate({
		op: "insert",
		index: 2,
		source: "Calling an async function returns a future.\n",
	})).toEqual({
		passage: "Calling an async function returns a future.",
		target: { op: "insert", index: 2 },
	});
});

test("the first handoff rejects larger or unsupported write batches", () => {
	expect(() =>
		visualCandidate({
			op: "insert_root",
			source: "First explanation.\n\nSecond explanation.",
		})
	).toThrow("exactly one explanatory paragraph");
	expect(() =>
		visualCandidate({
			op: "insert_root",
			source: "## Heading\n\nFirst explanation.",
		})
	).toThrow("exactly one explanatory paragraph");
	expect(() => visualCandidate({ op: "insert_root", source: "A list:\n\n- item" }))
		.toThrow("exactly one explanatory paragraph");
	expect(() =>
		visualWrite([
			{ op: "insert_root", source: "First explanation." },
			{ op: "insert_root", source: "Second explanation." },
		])
	).toThrow("one write operation");
	expect(visualWrite([{ op: "move", index: 1, to: 2 }])).toBeUndefined();
	expect(visualWrite([{ op: "insert_root", source: "## Token check" }])).toBeUndefined();
	expect(() => visualWrite([{ op: "insert_root", source: "- First\n- Second" }]))
		.toThrow("only headings or one explanatory paragraph");
	expect(() => visualWrite([{ op: "insert_root", source: "```seecode\n{}\n```" }]))
		.toThrow("only headings or one explanatory paragraph");
	expect(() =>
		visualWrite([{
			op: "insert_root",
			source: '<Callout type="note">\nCaveat.\n</Callout>',
		}])
	)
		.toThrow("only headings or one explanatory paragraph");
});
