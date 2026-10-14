import { expect, test } from "bun:test";
import { AGENTS, findAgent } from "@chopin/protocol/agents";
import {
	agentCommand,
	connectArguments,
	connectCommand,
	installCommand,
	pairCommand,
	quote,
	runsAsService,
} from "./setup-commands";

test("install uses the released installer for each shell, breaking before the pipe where the shell can", () => {
	expect(installCommand("sh")).toBe(
		[
			"curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh \\",
			"  | sh",
		].join("\n"),
	);
	expect(installCommand("powershell")).toBe(
		"irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex",
	);
});

test("connect breaks between whole arguments, with each shell's own line continuation", () => {
	expect(connectCommand("https://chopin.example", "sh")).toBe(
		[
			"CHOPIN_URL=https://chopin.example chopin connect . \\",
			"  --install-service \\",
			"  -- copilot --acp --allow-all",
		].join("\n"),
	);
	expect(connectCommand("https://chopin.example", "powershell")).toBe(
		[
			'$env:CHOPIN_URL="https://chopin.example"',
			"chopin connect . `",
			"  --install-service `",
			"  -- copilot --acp --allow-all",
		].join("\n"),
	);
});

test("connect passes the agent's --env on its own line, before the agent's command", () => {
	let atomic = findAgent("atomic");
	expect(connectCommand("https://chopin.example", "sh", atomic)).toBe(
		[
			"CHOPIN_URL=https://chopin.example chopin connect . \\",
			"  --install-service \\",
			"  --env ATOMIC_ACP_HEADLESS=1 \\",
			"  -- atomic-acp",
		].join("\n"),
	);
	expect(connectCommand("https://chopin.example", "powershell", atomic)).toBe(
		[
			'$env:CHOPIN_URL="https://chopin.example"',
			"chopin connect . `",
			"  --install-service `",
			"  --env ATOMIC_ACP_HEADLESS=1 `",
			"  -- atomic-acp",
		].join("\n"),
	);
});

test("an agent that asks for permission connects without the service, so a person can answer", () => {
	let claude = findAgent("claude-code");
	expect(runsAsService(claude)).toBe(false);
	expect(connectCommand("https://chopin.example", "sh", claude)).toBe(
		[
			"CHOPIN_URL=https://chopin.example chopin connect . \\",
			"  -- claude-agent-acp",
		].join("\n"),
	);
	expect(connectCommand("https://chopin.example", "powershell", claude)).toBe(
		[
			'$env:CHOPIN_URL="https://chopin.example"',
			"chopin connect . `",
			"  -- claude-agent-acp",
		].join("\n"),
	);
});

test("every agent that can run unattended connects as the service, in either shell", () => {
	for (let agent of AGENTS) {
		expect(runsAsService(agent)).toBe(agent.unattended === true);
		for (let shell of ["sh", "powershell"] as const) {
			expect(connectArguments(agent, shell).includes("--install-service"))
				.toBe(runsAsService(agent));
		}
	}
	expect(AGENTS.filter(runsAsService).map(agent => agent.id))
		.toEqual(["copilot", "atomic", "codex", "gemini"]);
});

test("installing an agent and signing in is one copyable block, @-scoped packages quoted for PowerShell", () => {
	let atomic = findAgent("atomic");
	expect(agentCommand(atomic, "sh")).toBe(
		[
			"npm install -g @bastani/atomic @bastani/atomic-acp",
			"atomic # sign in with /login, then quit",
		].join("\n"),
	);
	expect(agentCommand(atomic, "powershell")).toBe(
		[
			"npm install -g '@bastani/atomic' '@bastani/atomic-acp'",
			"atomic # sign in with /login, then quit",
		].join("\n"),
	);
	expect(agentCommand(findAgent("copilot"), "sh")).toBe(
		["npm install -g @github/copilot", "copilot login"].join("\n"),
	);
});

test("a word goes bare only where the shell reads it as itself", () => {
	expect(quote("--acp", "sh")).toBe("--acp");
	expect(quote("KEY=1", "powershell")).toBe("KEY=1");
	expect(quote("@scope/pkg", "sh")).toBe("@scope/pkg");
	expect(quote("@scope/pkg", "powershell")).toBe("'@scope/pkg'");
	expect(quote("a,b", "powershell")).toBe("'a,b'");
	expect(quote("it's $HOME", "sh")).toBe("'it'\\''s $HOME'");
	expect(quote("it's $HOME", "powershell")).toBe("'it''s $HOME'");
	expect(quote("", "sh")).toBe("''");
});

test("bash reads back every word of every agent's commands exactly as the list has it", () => {
	for (let agent of AGENTS) {
		let commands = [...agent.install, agent.signIn.command, [...agent.env, ...agent.acp]];
		for (let words of commands) {
			let line = words.map(word => quote(word, "sh")).join(" ");
			let read = Bun.spawnSync(["bash", "-c", `printf '%s\\n' ${line}`]).stdout.toString();
			expect(read).toBe(words.map(word => `${word}\n`).join(""));
		}
	}
});

test("pairing again keeps the machine's name, quoted only when the shell needs it", () => {
	expect(pairCommand("build-box.local")).toBe("chopin pair --label build-box.local");
	expect(pairCommand("Mia’s MacBook")).toBe('chopin pair --label "Mia’s MacBook"');
	// A name either shell would expand inside quotes falls back to the hostname default.
	expect(pairCommand('say "$HOME"')).toBe("chopin pair");
	expect(pairCommand("")).toBe("chopin pair");
});
