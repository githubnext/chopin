import { expect, test } from "bun:test";

let skill = await Bun.file(new URL("./SKILL.md", import.meta.url)).text();
let prompt = await Bun.file(new URL("./prompt.md", import.meta.url)).text();

test("the copied prompt delegates the canonical document to the MCP contract", () => {
	expect(prompt).toContain("<CANONICAL_CHOPIN_DOCUMENT_URL>");
	expect(prompt).toContain("Chopin MCP contract");
	expect(prompt).not.toMatch(/claude|codex|github copilot|bearer|token/i);
});

test("the skill stops unsafe graph execution", () => {
	expect(skill).toContain("Before claiming anything");
	expect(skill).toContain("repository and base reference");
	expect(skill).toContain("call `block_task`");
	expect(skill).not.toContain("request_revision");
	expect(skill).toContain("stop code changes");
	expect(skill).toContain("Do not edit Chopin plan or graph content");
});

test("the skill follows the implemented lifecycle through verification", () => {
	expect(skill).toContain("Independent ready roots may be delegated");
	expect(skill).toContain("separate review pass");
	expect(skill).toContain("verification evidence");
	expect(skill).toContain("exactly one pull request");

	let start = skill.indexOf("`start_task`");
	let report = skill.indexOf("`report_pr`");
	let complete = skill.indexOf("`complete_task`");
	let verify = skill.indexOf("`report_verification`");
	expect(start).toBeGreaterThan(-1);
	expect(report).toBeGreaterThan(start);
	expect(complete).toBeGreaterThan(report);
	expect(verify).toBeGreaterThan(complete);
});
