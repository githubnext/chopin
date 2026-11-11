import { describe, expect, it } from "bun:test";

import { documentPointers, headingAnchor, matchPointers, shortened } from "./pointers";

const SOURCE = [
	"# Overview",
	"",
	"Text.",
	"",
	"## Site 1: harbour survey",
	"",
	'<Callout type="info">',
	"",
	"### Inside a callout",
	"",
	"</Callout>",
	"",
	'<Questionnaire id="01HQ0000000000000000000000">',
	'<Question id="q1" header="Rollout" prompt="How should we deploy?" multiple="false">',
	'<Option id="o1" label="Canary" />',
	"</Question>",
	"</Questionnaire>",
	"",
	'<Research id="workspace-1" />',
	"",
	"# Overview",
	"",
	"## `Code` and *emphasis*",
	"",
].join("\n");

describe("what a document's own parts are", () => {
	it("lists its top-level headings with their anchors, levels and lines, a repeat after the first", () => {
		expect(documentPointers(SOURCE).headings).toEqual([
			{ anchor: "overview", text: "Overview", level: 1, line: 1 },
			{ anchor: "site-1-harbour-survey", text: "Site 1: harbour survey", level: 2, line: 5 },
			{ anchor: "overview-1", text: "Overview", level: 1, line: 21 },
			{ anchor: "code-and-emphasis", text: "Code and emphasis", level: 2, line: 23 },
		]);
	});

	it("lists its Decisions by id with their header, and its research cards by workspace id", () => {
		let { decisions, research } = documentPointers(SOURCE);
		expect(decisions).toEqual([{ id: "01HQ0000000000000000000000", title: "Rollout" }]);
		expect(research).toEqual(["workspace-1"]);
	});

	it("is empty for a document of prose, and for one that does not parse", () => {
		expect(documentPointers("Just words.\n")).toEqual({
			headings: [],
			decisions: [],
			research: [],
		});
		expect(documentPointers("<Questionnaire")).toEqual({
			headings: [],
			decisions: [],
			research: [],
		});
	});

	it("cuts a long heading or Decision header for its label, and keeps the anchor of all of it", () => {
		let long = "x".repeat(150);
		let found = documentPointers(`# ${long}\n`);
		expect(found.headings[0]!.anchor).toBe(long);
		expect([...found.headings[0]!.text]).toHaveLength(100);
		expect(found.headings[0]!.text.endsWith("…")).toBe(true);
		expect(shortened("short")).toBe("short");
	});

	it("slugs a heading as GitHub does, keeping letters, digits, hyphens and underscores", () => {
		expect(headingAnchor("What's next? (v2)")).toBe("whats-next-v2");
		expect(headingAnchor("Zürich – 日本語 plan_B")).toBe("zürich--日本語-plan_b");
		expect(headingAnchor("???")).toBe("section");
	});
});

describe("matching a typed query to a document's parts", () => {
	let titles = ["Overview", "Site survey", "A review of the overview", "Rollout"];
	it("is everything, in order, for an empty query, and no more than the limit", () => {
		expect(matchPointers(titles, "", 3)).toEqual([0, 1, 2]);
	});

	it("puts a title that starts with the query, then one with a word that does, then one that holds it", () => {
		expect(matchPointers(titles, "over", 8)).toEqual([0, 2]);
		expect(matchPointers(titles, "REV", 8)).toEqual([2]);
		expect(matchPointers(titles, "VIEW", 8)).toEqual([0, 2]);
		expect(matchPointers(["Zeta over", "Over zeta", "Hover"], "over", 8)).toEqual([1, 0, 2]);
		expect(matchPointers(titles, "site s", 8)).toEqual([1]);
		expect(matchPointers(titles, "zzz", 8)).toEqual([]);
	});
});
