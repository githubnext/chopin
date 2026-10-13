/** What /connect asks a person to run to set up a machine. Change the commands here only. */

export type SetupShell = "sh" | "powershell";

const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";

/** Everything after `chopin`: connect this checkout, then run it as a background service. */
export const CONNECT_ARGUMENTS = "connect . --install-service -- copilot --acp --allow-all";

export const SETUP_GUIDE = "https://github.com/githubnext/chopin/blob/main/docs/chopin-cli.md";

export function installCommand(shell: SetupShell): string {
	return shell === "powershell"
		? `irm ${RELEASES}/install.ps1 | iex`
		: `curl -fsSL ${RELEASES}/install.sh | sh`;
}

export function connectCommand(origin: string, shell: SetupShell): string {
	return shell === "powershell"
		? `$env:CHOPIN_URL="${origin}"; chopin ${CONNECT_ARGUMENTS}`
		: `CHOPIN_URL=${origin} chopin ${CONNECT_ARGUMENTS}`;
}
