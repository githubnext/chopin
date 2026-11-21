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
])("%s is told its repository is its microVM's own, and to push what it keeps", (_name, prompt) => {
	let text = prompt(worktrees);
	expect(text).toContain(
		"Your repository is /work/run, a clone of its own in this machine's microVM.",
	);
	expect(text).toContain("add them with `git worktree add` inside /work/run-worktrees");
	expect(text).toContain("gone when this run ends, so push what you keep");
	expect(text).not.toContain("CHOPIN_RUN_WORKTREES");
});

test("a rebuild never pushes to, reopens or recreates a pull request a person closed", () => {
	let text = rebuildPrompt(worktrees);
	expect(text).toContain("`gh pr view <url> --json state` says OPEN");
	expect(text).toContain(
		"Never push to, reopen or recreate the branch of a pull request a person closed or merged",
	);
	expect(text).toContain("closedPullRequests");
	expect(text).toContain("Never reopen a pull request.");
});

test("a rebuild links the document where it is now in every pull request body it touches", () => {
	let text = rebuildPrompt(worktrees);
	expect(text).toContain("link the document at document.url");
	expect(text).toContain("replace any of its document.earlierUrls there");
});
