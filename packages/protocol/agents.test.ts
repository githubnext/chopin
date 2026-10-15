import { expect, test } from "bun:test";
import { acpCommand, AGENTS, DEFAULT_AGENT, findAgent, nodeMajor, nodeOlder } from "./agents";

test("every agent names itself, how to install it, sign in and start it, and where its docs are", () => {
	let ids = AGENTS.map(agent => agent.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (let agent of AGENTS) {
		expect(agent.id).toMatch(/^[a-z][a-z-]*$/);
		expect(agent.name.trim()).toBe(agent.name);
		expect(agent.name).not.toBe("");
		expect(agent.install.length).toBeGreaterThan(0);
		for (let command of agent.install) expect(command.length).toBeGreaterThan(0);
		expect(agent.signIn.command.length).toBeGreaterThan(0);
		expect(agent.acp.length).toBeGreaterThan(0);
		expect(agent.docs).toMatch(/^https:\/\//);
		expect(typeof agent.testedWithChopin).toBe("boolean");
		// chopin connect refuses an --env it can't pass on.
		for (let variable of agent.env) {
			expect(variable).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=[\w.-]+$/);
			expect(variable).not.toMatch(/^(PATH|CHOPIN_)/);
		}
		if (agent.unattended !== true) expect(agent.unattended.setting).not.toBe("");
	}
});

test("the built-in agents are GitHub Copilot CLI and Atomic, in that order", () => {
	expect(AGENTS.map(agent => agent.name)).toEqual(["GitHub Copilot CLI", "Atomic"]);
});

test("GitHub Copilot CLI is the default, and an unknown choice falls back to it", () => {
	expect(DEFAULT_AGENT.name).toBe("GitHub Copilot CLI");
	expect(AGENTS[0]).toBe(DEFAULT_AGENT);
	expect(findAgent("atomic").name).toBe("Atomic");
	expect(findAgent("gone")).toBe(DEFAULT_AGENT);
	expect(findAgent("claude-code")).toBe(DEFAULT_AGENT);
	expect(findAgent(null)).toBe(DEFAULT_AGENT);
});

test("the agents run globally installed binaries, not npx", () => {
	for (let agent of AGENTS) {
		expect(agent.acp[0]).not.toBe("npx");
		for (let command of agent.install) expect(command[0]).not.toBe("npx");
	}
});

test("a Node.js version is older than an agent's minimum only below it", () => {
	expect(nodeOlder("v22.18.0", "22.19")).toBe(true);
	expect(nodeOlder("v22.19.0", "22.19")).toBe(false);
	expect(nodeOlder("v23.0.0", "22.19")).toBe(false);
	expect(nodeOlder("v21.7.3", "22")).toBe(true);
	expect(nodeOlder("v20.0.0", "20")).toBe(false);
	expect(nodeMajor("22.19")).toBe(22);
	for (let agent of AGENTS) expect(agent.node).toMatch(/^\d+(\.\d+)?$/);
});

test("extra arguments follow an agent's ACP command, after the separator its adapter wants", () => {
	expect(acpCommand(findAgent("copilot"), [])).toEqual(["copilot", "--acp", "--allow-all"]);
	expect(acpCommand(findAgent("copilot"), ["--model", "gpt-6-luna"]))
		.toEqual(["copilot", "--acp", "--allow-all", "--model", "gpt-6-luna"]);
	// atomic-acp passes what follows its own -- on to Atomic.
	expect(acpCommand(findAgent("atomic"), [])).toEqual(["atomic-acp"]);
	expect(acpCommand(findAgent("atomic"), ["--package", "/x"]))
		.toEqual(["atomic-acp", "--", "--package", "/x"]);
});
