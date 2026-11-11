import { describe, expect, test } from "bun:test";

import { pointerGroups } from "./mention-sources";

describe("what @ lists from the document and its repository", () => {
	test("are groups in the order a person looks for them, each option told by its identity", () => {
		let groups = pointerGroups({
			headings: [{ anchor: "overview", text: "Overview", level: 1 }],
			decisions: [{ id: "d1", title: "Rollout" }, { id: "d2", title: "" }],
			research: [{ workspaceId: "w1", title: "Release Research" }],
			files: ["src/index.ts"],
		});
		expect(groups.map(group => group.label)).toEqual([
			"Sections",
			"Decisions",
			"Research",
			"Files",
		]);
		expect(groups.flatMap(group => group.options)).toEqual([
			{
				id: "heading:overview",
				kind: "heading",
				anchor: "overview",
				label: "Overview",
				meta: "H1",
			},
			{ id: "decision:d1", kind: "decision", decisionId: "d1", label: "Rollout" },
			{ id: "decision:d2", kind: "decision", decisionId: "d2", label: "Decision" },
			{ id: "research:w1", kind: "research", workspaceId: "w1", label: "Release Research" },
			{ id: "file:src/index.ts", kind: "file", path: "src/index.ts", label: "src/index.ts" },
		]);
	});

	test("leave out a group with nothing in it, and every group before they are asked for", () => {
		expect(pointerGroups(undefined)).toEqual([]);
		expect(pointerGroups({ headings: [], decisions: [], research: [] })).toEqual([]);
		expect(
			pointerGroups({
				headings: [{ anchor: "a", text: "A", level: 2 }],
				decisions: [],
				research: [],
			}).map(group => group.label),
		).toEqual(["Sections"]);
	});
});
