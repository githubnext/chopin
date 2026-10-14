/** What /connect asks a person to run to set up a machine. Change the commands here only. */

export type SetupShell = "sh" | "powershell";

const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";

/**
 * Everything after `chopin`, one line per whole argument group: connect this checkout, run it as a
 * background service, then the coding agent it starts.
 */
export const CONNECT_ARGUMENTS = ["connect .", "--install-service", "-- copilot --acp --allow-all"];

export const SETUP_GUIDE = "https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md";

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
export function connectCommand(origin: string, shell: SetupShell): string {
	let [first, ...rest] = CONNECT_ARGUMENTS;
	let continuation = shell === "powershell" ? " `" : " \\";
	let lines = [`chopin ${first}`, ...rest.map(line => `  ${line}`)];
	let command = lines.map((line, index) => index < lines.length - 1 ? line + continuation : line);
	return shell === "powershell"
		? [`$env:CHOPIN_URL="${origin}"`, ...command].join("\n")
		: [`CHOPIN_URL=${origin} ${command[0]}`, ...command.slice(1)].join("\n");
}
