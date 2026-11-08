import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

/**
 * Every git command the connector runs itself, on the host and outside any sandbox, against a
 * repository an agent has been able to write, goes through here. Git runs what a repository's
 * configuration names, and an agent that got a line of it into the configuration, through a
 * `commondir` file or any way no sandbox policy foresaw, would be running its own programs as the
 * person. So these settings replace what a repository may set for the programs git runs in the
 * connector's commands: its hooks, its file-system monitor and its ssh command. They are given in
 * the environment (`GIT_CONFIG_COUNT`, after any entries the caller gave it), where they win over
 * every configuration file as `-c` does, so the command line the connector runs is unchanged.
 *
 * What is left alone, because it is the person's and the sandbox can't write it: their global
 * configuration, their system configuration (on Windows it carries the certificate bundle and the
 * credential manager) and their credential helpers (the connector's own token helper is given
 * through the environment and resets the ones for github.com before it). `protocol.file.allow` is
 * left at git's own `user`, which already refuses the file transport inside a submodule, where the
 * connector never runs git.
 */
export const HOST_GIT_CONFIG: Array<[string, string]> = [
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
];

let sshCommands = new Map<string, string>();

/**
 * The ssh command git would use without a repository's say: the person's own `GIT_SSH_COMMAND`,
 * else their global `core.sshCommand`, else `GIT_SSH`, else `ssh`.
 */
function sshCommand(env: NodeJS.ProcessEnv) {
	let key = `${env.GIT_SSH ?? ""}\0${env.HOME ?? ""}\0${env.XDG_CONFIG_HOME ?? ""}`;
	let known = sshCommands.get(key);
	if (known !== undefined) return known;
	let result = spawnSync("git", ["config", "--global", "--includes", "--get", "core.sshCommand"], {
		encoding: "utf8",
		env,
		timeout: 10_000,
	});
	let configured = result.status === 0 ? result.stdout.trim() : "";
	let command = configured || env.GIT_SSH || "ssh";
	sshCommands.set(key, command);
	return command;
}

/**
 * The environment for a host git command: `env`, with the settings above after its own
 * `GIT_CONFIG_*` entries, and the ssh command the person chose pinned over a repository's.
 */
export function hostGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	let count = Number(env.GIT_CONFIG_COUNT ?? 0);
	if (!Number.isInteger(count) || count < 0) count = 0;
	let hardened: NodeJS.ProcessEnv = {
		...env,
		GIT_CONFIG_COUNT: String(count + HOST_GIT_CONFIG.length),
	};
	HOST_GIT_CONFIG.forEach(([key, value], index) => {
		hardened[`GIT_CONFIG_KEY_${count + index}`] = key;
		hardened[`GIT_CONFIG_VALUE_${count + index}`] = value;
	});
	if (!env.GIT_SSH_COMMAND) hardened.GIT_SSH_COMMAND = sshCommand(env);
	return hardened;
}

/** Run git to its end, as `spawnSync` does. */
export function gitSync(
	args: string[],
	options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
	return spawnSync("git", args, {
		encoding: "utf8",
		...options,
		env: hostGitEnvironment(options.env ?? process.env),
	});
}

const execFileAsync = promisify(execFile);

/** Run git to its end, as `execFile` does, resolving with its output and rejecting as it fails. */
export function gitAsync(
	args: string[],
	options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
) {
	return execFileAsync("git", args, {
		...options,
		env: hostGitEnvironment(options.env ?? process.env),
	});
}
