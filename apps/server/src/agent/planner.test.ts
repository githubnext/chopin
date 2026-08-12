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

test("asks later decisions beside their related prose", () => {
	expect(PROMPT).toContain("include its related block addresses in `ask`");
	expect(PROMPT).toContain("write the relevant prose first");
	expect(PROMPT).toContain("Do not collect decisions at the end of the plan");
});
