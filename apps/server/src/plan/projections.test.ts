import { expect, test } from "bun:test";
import { parse, serialize } from "@chopin/dialect";
import {
	newResearchProjections,
	protectProjections,
	removedResearchProjections,
} from "./projections";

let nodes = (source: string) => parse(source).children;

test.each([
	'<Callout>\n\n<Decision id="same" />\n\n<Questionnaire id="same" />\n\n</Callout>',
	'> <Research id="same" />\n\n<Decision id="same" />',
])("nested protected identities cannot collide across kinds: %s", source => {
	let proposed = nodes(source);
	expect(protectProjections([], proposed)).toContain("appears twice");
	expect(protectProjections(proposed, [])).toContain("appears twice");
	expect(newResearchProjections([], proposed)).toEqual([]);
	expect(removedResearchProjections(proposed, [])).toEqual([]);
});

test.each([
	"<Callout>\n\n<Questionnaire />\n\n</Callout>",
	'<Decision id="" />',
	"> <Research />",
])("missing or empty identity fails closed in either snapshot: %s", source => {
	let malformed = nodes(source);
	expect(protectProjections([], malformed)).toContain("missing its id");
	expect(protectProjections(malformed, [])).toContain("missing its id");
	expect(newResearchProjections([], malformed)).toEqual([]);
	expect(removedResearchProjections(malformed, [])).toEqual([]);
});

test.each(["Questionnaire", "Decision"])(
	"Research exceptions never authorize new or removed %s",
	kind => {
		let projection = nodes(`<${kind} id="card" />`);
		let ids = new Set(["card"]);
		expect(protectProjections([], projection, ids, ids)).toContain("cannot be authored");
		expect(protectProjections(projection, [], ids, ids)).toContain("cannot be dropped");
	},
);

test.each([
	['<Decision id="card" quote="Original" />', '<Decision id="card" quote="Changed" />'],
	[
		'<Questionnaire id="card">Original</Questionnaire>',
		'<Questionnaire id="card">Changed</Questionnaire>',
	],
	['<Decision id="card" />', '<Research id="card" />'],
])("same identity cannot conceal a changed payload or kind: %s", (before, after) => {
	let ids = new Set(["card"]);
	expect(protectProjections(nodes(before), nodes(after), ids, ids)).toContain("cannot be altered");
});

test("exact nested projections may move while unrelated prose changes", () => {
	let card = '<Questionnaire id="card">Original choice</Questionnaire>';
	let before = nodes(`Before.\n\n<Callout>\n\n${card}\n\n</Callout>\n\n<Research id="report" />`);
	let after = nodes(`<Research id="report" />\n\nChanged prose.\n\n${card}`);
	let canonical = serialize({ type: "root", children: after });
	expect(canonical).toContain("Changed prose.");
	expect(protectProjections(before, after)).toBeUndefined();
	expect(newResearchProjections(before, after)).toEqual([]);
	expect(removedResearchProjections(before, after)).toEqual([]);
});

test("Research additions and removals require the exact IDs in the correct authority sets", () => {
	let before = nodes('<Research id="old" />');
	let after = nodes('<Research id="new" />');
	expect(newResearchProjections(before, after)).toEqual(["new"]);
	expect(removedResearchProjections(before, after)).toEqual(["old"]);
	expect(protectProjections(before, after)).toContain("cannot be dropped");
	expect(protectProjections(before, after, new Set(["new"]))).toContain("cannot be dropped");
	expect(protectProjections(before, after, new Set(), new Set(["old"])))
		.toContain("cannot be authored");
	expect(protectProjections(before, after, new Set(["old"]), new Set(["new"])))
		.toContain("cannot be dropped");
	expect(protectProjections(before, after, new Set(["new"]), new Set(["old"])))
		.toBeUndefined();
});
