/** What /connect asks a person to run to set up a machine. Change the commands here only. */

export type SetupShell = "sh" | "powershell";

const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";

/**
 * Everything after `chopin`, one line per whole argument group: connect this checkout, run it as a
 * background service, then the coding agent it starts.
 */
export const CONNECT_ARGUMENTS = ["connect .", "--install-service", "-- copilot --acp --allow-all"];

export const SETUP_GUIDE = "https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md";

export function installCommand(shell: SetupShell): string {
	return shell === "powershell"
		? `irm ${RELEASES}/install.ps1 | iex`
		: `curl -fsSL ${RELEASES}/install.sh | sh`;
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
