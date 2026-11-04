import { expect, test } from "bun:test";

import { implementationPrompt, liveImplementationPrompt, rebuildPrompt } from "./implementation";

let worktrees = { root: "/work/run", extras: "/work/run-worktrees" };

test.each([
	["a build", implementationPrompt, "read_implementation"],
	["a living document's first build", liveImplementationPrompt, "read_implementation"],
	["a rebuild", rebuildPrompt, "read_rebuild"],
])("%s builds on best judgment while decisions are open and lists them in pull requests", (
	_name,
	prompt,
	read,
) => {
	let text = prompt(worktrees);
	expect(text).toContain(`If ${read} returns unapprovedDecisions, those decisions are still open.`);
	expect(text).toContain("Never wait for one, block a task on one, or answer or close one");
	expect(text).toContain("use your best judgment");
	expect(text).toContain("pullRequestSection, unchanged");
});
