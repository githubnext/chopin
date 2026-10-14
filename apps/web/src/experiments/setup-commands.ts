/** The commands the Machines page shows to set up a machine. Change them here only. */

import type { CodingAgent } from "@chopin/protocol/agents";

export type SetupShell = "sh" | "powershell";

const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";

/**
 * One word as the shell should be given it. A word of plain characters goes bare; others go in
 * single quotes, inside which neither shell expands anything. PowerShell also reads a leading `@`
 * as splatting and a comma as an array, so those words are quoted there too.
 */
export function quote(word: string, shell: SetupShell): string {
	if (shell === "sh") {
		return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
	}
	return /^[\w%+=:./-]+$/.test(word) ? word : `'${word.replaceAll("'", "''")}'`;
}

function words(list: string[], shell: SetupShell): string {
	return list.map(word => quote(word, shell)).join(" ");
}

/** What follows `chopin connect .` for this agent, short of the service: its `--env`, then `--`. */
export function agentArguments(agent: CodingAgent): string[] {
	return [...agent.env.flatMap(variable => ["--env", variable]), "--", ...agent.acp];
}

/**
 * Whether setup installs the background service for this agent. The service is the recommended
 * way to run, since it outlives the terminal; only an agent that would wait on a permission prompt
 * nobody can answer runs in the terminal instead.
 */
export function runsAsService(agent: CodingAgent): boolean {
	return agent.unattended === true;
}

/**
 * Everything after `chopin`, one line per whole argument group: connect this checkout, run it as a
 * background service if the agent can run unattended, its variables, then the agent it starts.
 */
export function connectArguments(agent: CodingAgent, shell: SetupShell = "sh"): string[] {
	return [
		"connect .",
		...(runsAsService(agent) ? ["--install-service"] : []),
		...agent.env.map(variable => `--env ${quote(variable, shell)}`),
		`-- ${words(agent.acp, shell)}`,
	];
}

/** Installs the agent, then signs in to it: one block, each line a command of its own. */
export function agentCommand(agent: CodingAgent, shell: SetupShell): string {
	let { command, afterward } = agent.signIn;
	return [
		...agent.install.map(install => words(install, shell)),
		words(command, shell) + (afterward ? ` # ${afterward}` : ""),
	].join("\n");
}

export const SETUP_GUIDE = "https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md";
export const SETUP_GUIDE_TROUBLESHOOTING = `${SETUP_GUIDE}#troubleshooting`;

/** Installs the release this server recommends over the machine's chopin, as `chopin help` says. */
export const UPDATE_COMMAND = "chopin update";

/**
 * Pairs a machine again under the name it has in Chopin. Plain names go bare; others in double
 * quotes, which sh and PowerShell read alike unless the name holds a character either expands or
 * ends a string on. Such a name, or none, leaves `--label` out, so chopin uses the hostname.
 */
export function pairCommand(label: string): string {
	if (/^[\w.-]+$/.test(label)) return `chopin pair --label ${label}`;
	if (!label || /["$`\\!\u201C\u201D\u201E]/.test(label)) return "chopin pair";
	return `chopin pair --label "${label}"`;
}

/** Where install.sh and install.ps1 put chopin, so the command runs it before PATH has it. */
const INSTALLED = {
	sh: "~/.local/bin/chopin",
	powershell: '"$env:LOCALAPPDATA\\chopin\\bin\\chopin.exe"',
};

/**
 * The one command that sets up a machine: install chopin, then, only if that worked, connect this
 * checkout with a single-use pairing key, running chopin by the path the installer used. Over
 * several lines so it never wraps inside an argument; it runs as one when pasted.
 *
 * sh downloads the installer to a file first, since `curl | sh` succeeds when curl fails and sh
 * reads nothing; each step runs only if the one before it succeeded, so a failure stops with
 * curl's or the installer's own message. The key goes in the environment of the one command,
 * where other users can't read it as they can a command line.
 *
 * PowerShell connects only if install.ps1 left $LASTEXITCODE 0, and sets the key in the
 * environment for chopin alone, removing it afterwards even on Ctrl-C. It is first assigned to
 * `$token` because PSReadLine (2.0.4 and later) keeps a line that assigns a value to a variable
 * named like a token or secret out of its history file. PSReadLine 2.0.0, which Windows PowerShell
 * 5.1 ships, saves every line; the key is single-use and spent by this command, so that copy
 * outlives its use by ten minutes at most.
 */
export function setupCommand(
	origin: string,
	shell: SetupShell,
	agent: CodingAgent,
	key: string,
): string {
	let [connect, ...rest] = connectArguments(agent, shell);
	if (shell === "powershell") {
		let lines = [`& ${INSTALLED.powershell} ${connect}`, ...rest.map(line => `  ${line}`)];
		return [
			`irm ${RELEASES}/install.ps1 | iex`,
			"if ($LASTEXITCODE -eq 0) {",
			`  $token = '${key.replaceAll("'", "''")}'`,
			`  $env:CHOPIN_URL = "${origin}"`,
			"  $env:CHOPIN_PAIRING_KEY = $token",
			"  try {",
			...lines.map((line, index) => `    ${line}${index < lines.length - 1 ? " `" : ""}`),
			"  } finally { Remove-Item Env:CHOPIN_PAIRING_KEY; Remove-Variable token }",
			"}",
		].join("\n");
	}
	let lines = [
		"installer=$(mktemp)",
		'  && curl -fsSL -o "$installer"',
		`  ${RELEASES}/install.sh`,
		'  && sh "$installer" && rm -f "$installer"',
		`  && CHOPIN_URL=${quote(origin, shell)}`,
		`  CHOPIN_PAIRING_KEY=${quote(key, shell)}`,
		`  ${INSTALLED.sh} ${connect}`,
		...rest.map(line => `  ${line}`),
	];
	return lines.map((line, index) => index < lines.length - 1 ? `${line} \\` : line).join("\n");
}
