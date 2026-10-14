/** What /connect asks a person to run to set up a machine. Change the commands here only. */

import { DEFAULT_AGENT } from "./agents";

import type { CodingAgent } from "./agents";

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

/**
 * The installer, piped into the shell. The sh form breaks before the pipe so the pipe stays in view
 * on a narrow screen; the continuation keeps the copied text one command.
 */
export function installCommand(shell: SetupShell): string {
	return shell === "powershell"
		? `irm ${RELEASES}/install.ps1 | iex`
		: `curl -fsSL ${RELEASES}/install.sh \\\n  | sh`;
}

/**
 * The connect command over several lines, so it never wraps inside an argument. Each line but the
 * last ends in the shell's continuation, so the copied text runs as one command.
 */
export function connectCommand(
	origin: string,
	shell: SetupShell,
	agent: CodingAgent = DEFAULT_AGENT,
): string {
	let [first, ...rest] = connectArguments(agent, shell);
	let continuation = shell === "powershell" ? " `" : " \\";
	let lines = [`chopin ${first}`, ...rest.map(line => `  ${line}`)];
	let command = lines.map((line, index) => index < lines.length - 1 ? line + continuation : line);
	return shell === "powershell"
		? [`$env:CHOPIN_URL="${origin}"`, ...command].join("\n")
		: [`CHOPIN_URL=${origin} ${command[0]}`, ...command.slice(1)].join("\n");
}
