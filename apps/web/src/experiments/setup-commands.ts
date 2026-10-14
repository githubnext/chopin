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

/** What follows `chopin connect` for this agent, short of the service: its `--env`, then `--`. */
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
 * `connect` and its arguments, as the installer is given them: as the background service if
 * `background`, the agent's variables, then the agent it starts. PowerShell takes a bare -- as the
 * end of a script block's own parameters and passes nothing for it, so there it goes in quotes.
 */
export function connectArguments(
	agent: CodingAgent,
	shell: SetupShell,
	background = runsAsService(agent),
): string {
	return [
		"connect",
		...(background ? ["--install-service"] : []),
		...agent.env.map(variable => `--env ${quote(variable, shell)}`),
		shell === "powershell" ? "'--'" : "--",
		words(agent.acp, shell),
	].join(" ");
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

/** A PowerShell string that expands nothing. */
function literal(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}

export type SetupSystem = "linux" | "macos" | "windows";

/** The system this browser runs on, as the likeliest one to set up; phones get Linux. */
export function guessSystem(userAgent: string): SetupSystem {
	if (userAgent.includes("Windows")) return "windows";
	if (userAgent.includes("Macintosh")) return "macos";
	return "linux";
}

export function shellFor(system: SetupSystem): SetupShell {
	return system === "windows" ? "powershell" : "sh";
}

/**
 * The one command that sets up a machine: the installer installs chopin, then, only if that
 * worked, runs `chopin connect` for this checkout itself. Without a key, connect prints a link to
 * approve in the browser; with one (for a server, where nobody opens a browser), it pairs at once.
 * Two lines, broken at the pipe, so the installer's URL stays whole.
 *
 * sh passes CHOPIN_URL and the key in the environment of `sh` alone, where other users can't read
 * them as they can a command line. If curl can't download the installer, it says why and sh,
 * given no script, runs nothing.
 *
 * PowerShell sets them in the session, and install.ps1 removes the key once chopin has run (or
 * the install failed). The key is first assigned to `$token`, removed at once, because PSReadLine
 * (2.0.4 and later) keeps a line that assigns a literal to a variable named like a token out of
 * its history file. PSReadLine 2.0.0, which Windows PowerShell 5.1 ships, saves every line; the
 * key is single-use and spent by this command, so that copy outlives its use by ten minutes at most.
 */
export function setupCommand(
	origin: string,
	shell: SetupShell,
	agent: CodingAgent,
	{ key, background }: { key?: string; background?: boolean } = {},
): string {
	let connect = connectArguments(agent, shell, background);
	if (shell === "powershell") {
		return [
			[
				`$env:CHOPIN_URL = ${literal(origin)}`,
				...(key
					? [`$env:CHOPIN_PAIRING_KEY = ($token = ${literal(key)})`, "Remove-Variable token"]
					: []),
			].join("; "),
			`& ([scriptblock]::Create((irm ${RELEASES}/install.ps1))) ${connect}`,
		].join("\n");
	}
	let environment = [
		`CHOPIN_URL=${quote(origin, shell)}`,
		...(key ? [`CHOPIN_PAIRING_KEY=${quote(key, shell)}`] : []),
	];
	return `curl -fsSL ${RELEASES}/install.sh | \\\n  ${environment.join(" ")} sh -s -- ${connect}`;
}
