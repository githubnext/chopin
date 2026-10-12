import { expect, test } from "bun:test";
import { limits, parse } from "@chopin/dialect";
import { parseResult } from "@chopin/experiment";
import { performance } from "@chopin/experiment/fixtures";
import { canonical } from "../mcp/create";
import { investigationDocument, investigationSummary } from "./document";

const ID = "6f1c3c2e-8b0a-4c43-9d55-2d6f3c1b9a10";

test("a completed result becomes a research-shaped child that round-trips the dialect", () => {
	let document = investigationDocument(ID, "Does caching help startup?", performance);
	expect(document.title).toBe("Startup comparison");
	expect(canonical(document.source)).toEqual({ source: document.source });
	let headings = document.source.split("\n").filter(line => line.startsWith("#"));
	expect(headings).toEqual(["# Startup comparison", "## Views", "## Method", "## Limitations"]);
	expect(document.source).toContain("Caching reduced median startup time");
	let embeds = JSON.stringify(parse(document.source)).match(/"name":"Experiment"/g);
	expect(embeds).toHaveLength(1);
	expect(document.source).toMatch(
		new RegExp(`<Experiment id="[0-9A-Z]{26}" experiment="${ID}" view="comparison" />`),
	);
	expect(investigationSummary("Does caching help startup?", performance)).toBe(
		"Caching reduced median startup time in the captured workload.",
	);
});

test("the brief names a report without its own heading, and markup stays inert", () => {
	let result = parseResult({
		...performance,
		report: "Plain finding with `code` and {braces}.\n",
		views: [],
		evidence: [{ key: "log", title: "Run <log>", format: "plain", text: "```\n{x}\n```" }],
		provenance: {
			environment: "Laptop {env}",
			checks: ["<b>ran</b>", "Compared medians"],
			limitations: ["One", "Two"],
		},
	});
	let document = investigationDocument(ID, "Measure *startup*\nwith detail", result);
	expect(document.title).toBe("Measure startup");
	expect(document.source.startsWith("# Measure startup\n")).toBe(true);
	expect(canonical(document.source)).toEqual({ source: document.source });
	expect(document.source).not.toContain("<Experiment");
	expect(document.source).toContain("````\n```\n{x}\n```\n````");
});

test("evidence is clipped to keep the child inside the source limit", () => {
	let result = parseResult({
		...performance,
		evidence: [..."abcdefgh"].map(key => ({
			key,
			title: key,
			format: "plain",
			text: "x".repeat(64 * 1024),
		})),
		report: `# Big\n\n${"word ".repeat(20_000)}\n`,
	});
	let document = investigationDocument(ID, "Big", result);
	expect(Buffer.byteLength(document.source)).toBeLessThanOrEqual(limits.MAX_SOURCE_BYTES);
	expect(document.source).toContain("## Evidence");
});

test("a report cannot embed record-backed components into its child", () => {
	for (
		let component of [
			`<Investigation id="${ID}" />`,
			`<Experiment id="01K0N4W3B7P27CBAEC7A8C8WEH" experiment="${ID}" view="comparison" />`,
			`<Research id="${ID}" />`,
		]
	) {
		let result = parseResult({ ...performance, report: `# Report\n\n${component}\n` });
		expect(() => investigationDocument(ID, "Brief", result)).toThrow(
			"A report cannot embed record-backed components.",
		);
	}
});
