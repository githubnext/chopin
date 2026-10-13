import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceProgram } from "./service";

/** The service `chopin service install` set up, so status, restart and reinstall know it. */
export type InstalledService = ServiceProgram & {
	/** The chopin version that installed it; an older chopin refuses to replace it. */
	version: string;
	installedAt: number;
};

/** What `chopin connect` last ran here, which `chopin connect --service` runs. */
export type ConnectSettings = {
	/** The Chopin origin connect connected to: CHOPIN_URL, or the default. */
	server: string;
	/** The checkout's absolute root. */
	checkout: string;
	/** The agent's ACP command, as `connect` takes it after `--`. */
	command: string[];
	/** Documents whose Planner backend connect runs, and the backend's command words. */
	planners: string[];
	plannerCommand: string[];
};

/**
 * config.json in the state directory: what `chopin connect` and `chopin service install` stored.
 * It holds no secret; the machine token stays in machine.json.
 */
export type Config = {
	connect?: ConnectSettings;
	service?: InstalledService;
};

export function configFile(directory: string) {
	return join(directory, "config.json");
}

export async function readConfig(directory: string): Promise<Config> {
	try {
		let value = JSON.parse(await readFile(configFile(directory), "utf8")) as Config;
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

/** Read, change and write config.json whole, through a temporary file and a rename. */
export async function updateConfig(directory: string, change: (value: Config) => void) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let value = await readConfig(directory);
	change(value);
	let path = configFile(directory);
	let temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(value, null, "\t") + "\n", { mode: 0o600 });
	await rename(temporary, path);
}
