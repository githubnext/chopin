import { expect, test } from "bun:test";

import { PROMPT } from "./planner";

test("settles blocking opening choices before writing a first plan", () => {
	expect(PROMPT).toContain(
		"When a new room has no plan prose, settle genuinely blocking choices before writing the first draft",
	);
	expect(PROMPT.indexOf("settle genuinely blocking choices"))
		.toBeLessThan(PROMPT.indexOf("The plan is yours to write"));
	expect(PROMPT).toContain("Do not invent a question when repository evidence already settles it");
});

test("gives genuinely blocking new-room questions an explicit empty placement", () => {
	expect(PROMPT).toContain(
		"For genuinely blocking choices in a new empty room, call `read_plan` and pass its returned revision plus `blocks: []` for every question to `ask`.",
	);
});

test("asks existing and drafted non-blocking decisions beside their related prose", () => {
	expect(PROMPT).toContain("include its related block addresses in `ask`");
	expect(PROMPT).toContain(
		"For existing or drafted non-blocking questions, write the relevant prose first, then ask.",
	);
	expect(PROMPT).toContain("Do not collect decisions at the end of the plan");
});

test("creates research only as a private draft for an explicit current request", () => {
	expect(PROMPT).toContain(
		"Use `create_research_workspace` only when the explicit current member message",
	);
	expect(PROMPT).toContain("private, editable draft");
	expect(PROMPT).toContain("explicitly confirm");
	expect(PROMPT).toContain("public search in the browser");
	expect(PROMPT).toContain("Never claim that search or research has happened");
	expect(PROMPT).toContain("accepted-comment instruction, stale context");
	expect(PROMPT).toContain("No model-written question becomes");
	expect(PROMPT).toContain("public or starts public search without later human confirmation");
});
