import { expect, test } from "bun:test";
import { AGENTS, DEFAULT_AGENT, findAgent } from "./agents";

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
		// What lets it run under the service is in the command it runs.
		if (agent.autoApprove) {
			expect([...agent.acp, ...agent.env]).toContain(agent.autoApprove);
		}
		if (agent.unattended !== true) expect(agent.unattended.setting).not.toBe("");
	}
});

test("GitHub Copilot CLI is the default, and an unknown choice falls back to it", () => {
	expect(DEFAULT_AGENT.name).toBe("GitHub Copilot CLI");
	expect(AGENTS[0]).toBe(DEFAULT_AGENT);
	expect(findAgent("atomic").name).toBe("Atomic");
	expect(findAgent("gone")).toBe(DEFAULT_AGENT);
	expect(findAgent(null)).toBe(DEFAULT_AGENT);
});

test("the agents run globally installed binaries, not npx", () => {
	for (let agent of AGENTS) {
		expect(agent.acp[0]).not.toBe("npx");
		for (let command of agent.install) expect(command[0]).not.toBe("npx");
	}
});
