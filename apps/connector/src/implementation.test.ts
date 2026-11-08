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

test.each([
	["a build", implementationPrompt, "read_implementation"],
	["a living document's first build", liveImplementationPrompt, "read_implementation"],
	["a rebuild", rebuildPrompt, "read_rebuild"],
])("%s asked for by a teammate says so in every pull request it opens", (_name, prompt, read) => {
	let text = prompt(worktrees);
	expect(text).toContain(`If ${read} returns requestedBy, a teammate asked for this build`);
	expect(text).toContain(
		"put its pullRequestNote, unchanged, at the end of the body of every pull request",
	);
});

test.each([
	["a build", implementationPrompt],
	["a living document's first build", liveImplementationPrompt],
	["a rebuild", rebuildPrompt],
])(
	"%s in the sandbox is told it can't add worktrees, rather than to make them",
	(_name, prompt) => {
		let open = prompt(worktrees);
		expect(open).toContain("create them only inside /work/run-worktrees");
		let confined = prompt({ ...worktrees, confined: true });
		expect(confined).toContain("Your worktree is /work/run.");
		expect(confined).toContain("`git worktree add` fails");
		expect(confined).toContain("each one from its own branch in your worktree");
		expect(confined).not.toContain("create them only inside");
		expect(confined).not.toContain("CHOPIN_RUN_WORKTREES");
	},
);
