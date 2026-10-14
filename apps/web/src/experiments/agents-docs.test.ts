import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS } from "./agents";
import {
	agentArguments,
	SETUP_GUIDE,
	SETUP_GUIDE_AGENTS,
	SETUP_GUIDE_TROUBLESHOOTING,
} from "./setup-commands";

import type { CodingAgent } from "./agents";

const ROOT = join(import.meta.dir, "../../../..");

/** A table as dprint formats it: each column as wide as its widest cell. */
function table(head: string[], rows: string[][]): string {
	let widths = head.map((cell, column) =>
		Math.max(cell.length, ...rows.map(row => row[column]!.length))
	);
	let line = (cells: string[]) =>
		`| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
	return [line(head), line(widths.map(width => "-".repeat(width))), ...rows.map(line)].join("\n");
}

let code = (words: string[]) => `\`${words.join(" ")}\``;
let name = (agent: CodingAgent) => `[${agent.name}](${agent.docs})`;
let install = (agent: CodingAgent) => agent.install.map(code).join(", then ");
let signIn = (agent: CodingAgent) =>
	code(agent.signIn.command) + (agent.signIn.afterward ? `, ${agent.signIn.afterward}` : "");
let tested = (agent: CodingAgent) => agent.testedWithChopin ? "Yes" : "No";

/** The table docs/chopin-cli.md shows, from the agent list the Machines page uses. */
function guideTable(): string {
	return table(
		["Agent", "Install", "Sign in", "Connect with", "Tested with Chopin"],
		AGENTS.map(agent => [
			name(agent),
			install(agent),
			signIn(agent),
			code(agentArguments(agent)),
			tested(agent),
		]),
	);
}

/** The README's shorter table. */
function readmeTable(): string {
	return table(
		["Agent", "Install", "Connect with", "Tested with Chopin"],
		AGENTS.map(agent => [name(agent), install(agent), code(agentArguments(agent)), tested(agent)]),
	);
}

/** The table in a Markdown file whose header starts `| Agent `, so a failure shows only it. */
async function documented(path: string): Promise<string> {
	let lines = (await readFile(join(ROOT, path), "utf8")).split("\n");
	let start = lines.findIndex(line => line.startsWith("| Agent "));
	if (start < 0) return `no agent table in ${path}`;
	let end = lines.findIndex((line, index) => index > start && !line.startsWith("|"));
	return lines.slice(start, end).join("\n");
}

// To change a table, change the agent list, then paste the expected table this prints.
test("the setup guide's agent table matches the agent list", async () => {
	expect(await documented("docs/chopin-cli.md")).toBe(guideTable());
});

test("the README's agent table matches the agent list", async () => {
	expect(await documented("README.md")).toBe(readmeTable());
});

/** The anchors GitHub gives a Markdown file's headings: lower case, punctuation gone, dashes. */
async function anchors(path: string): Promise<string[]> {
	let text = await readFile(join(ROOT, path), "utf8");
	return [...text.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
		heading!.trim().toLowerCase().replace(/[^\w\- ]/g, "").replaceAll(" ", "-")
	);
}

test("the setup guide sections the Machines page links to are headings in the guide", async () => {
	let headings = await anchors("docs/chopin-cli.md");
	for (let link of [SETUP_GUIDE_AGENTS, SETUP_GUIDE_TROUBLESHOOTING]) {
		let [page, anchor] = link.split("#");
		expect(page).toBe(SETUP_GUIDE);
		expect(headings).toContain(anchor!);
	}
});
