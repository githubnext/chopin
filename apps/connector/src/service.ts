import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import { execFile } from "node:child_process";
import { checkAgent } from "./acp";
import { type ConnectSettings, readConfig, updateConfig } from "./config";
import { redacted } from "./connection";
import { VERSION } from "./version";
import { connectors, processStart } from "./workspace";

/**
 * `chopin service`: run `chopin connect` as this user's background service, so the machine keeps
 * serving its checkout after a reboot or logout. Linux uses a systemd user unit, macOS a
 * LaunchAgent and Windows a Task Scheduler task. Every service manager call goes through a
 * runner the caller supplies, and nothing here writes a secret: the service reads machine.json
 * when it starts.
 */

type Env = Record<string, string | undefined>;

/** Directories a version manager makes for one shell, which vanish with it or with a reboot. */
const PER_SHELL = new Set(["fnm_multishells"]);

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Whether a path lies in a directory that lasts only as long as a login or a shell: under
 * $XDG_RUNTIME_DIR or /run/user, or in a per-shell version-manager directory.
 */
function temporaryPath(platform: NodeJS.Platform, env: Env) {
	let windows = platform === "win32";
	let path = windows ? win32 : posix;
	let separator = windows ? "\\" : "/";
	let runtime = [env.XDG_RUNTIME_DIR, ...(windows ? [] : ["/run/user"])]
		.filter((value): value is string => !!value && path.isAbsolute(value))
		.map(value => pathKey(platform, value))
		.filter(value => value !== pathKey(platform, path.parse(value).root));
	return (entry: string) => {
		let value = pathKey(platform, entry);
		return runtime.some(directory => value === directory || value.startsWith(directory + separator))
			|| value.split(separator).some(part => PER_SHELL.has(part));
	};
}

function pathKey(platform: NodeJS.Platform, entry: string) {
	let windows = platform === "win32";
	let trimmed = entry.replace(windows ? /[\\/]+$/ : /\/+$/, "") || entry;
	return windows ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
}

/**
 * The PATH the service runs with: the agent executable's directory first, so the agent and a
 * Node or Bun installed beside it resolve after a reboot, then this shell's own entries without
 * empty ones, repeats, or directories that last only as long as a login or a shell. On Windows,
 * where the task sets it inside cmd's quotes, entries lose their quotes, and those with a % or a
 * control character are left out.
 */
export function servicePath(platform: NodeJS.Platform, env: Env, agentDirectory: string) {
	let windows = platform === "win32";
	let path = windows ? win32 : posix;
	let key = (entry: string) => pathKey(platform, entry);
	let temporary = temporaryPath(platform, env);
	let name = windows
		? Object.keys(env).find(item => item.toUpperCase() === "PATH") ?? "Path"
		: "PATH";
	let inherited = env[name] ?? (windows ? "" : DEFAULT_PATH);
	let kept = new Map<string, string>([[key(agentDirectory), agentDirectory]]);
	for (let given of inherited.split(path.delimiter)) {
		let entry = windows ? given.replaceAll('"', "") : given;
		if (windows && (entry.includes("%") || hasControl(entry))) continue;
		if (entry && !kept.has(key(entry)) && !temporary(entry)) kept.set(key(entry), entry);
	}
	return [...kept.values()].join(path.delimiter);
}

/** What the service runs: the installed chopin, with the state directory holding its settings. */
export type ServiceProgram = {
	/** The absolute path of the installed chopin. */
	executable: string;
	/** The state directory, passed as `--base-dir`; config.json, machine.json and the log live there. */
	directory: string;
};

export const CONNECT_FIRST = "Run chopin connect once in your checkout first, then chopin service "
	+ "install.";

export const UNIT = "chopin.service";
export const LABEL = "com.github.chopin";
/** How long a stopping service may take to report its runs stopped before it is killed. */
export const STOP_SECONDS = 90;

const DOCUMENTATION = "https://github.com/githubnext/chopin/blob/main/docs/local-experiments.md";
const DESCRIPTION = "Chopin connector: runs the work you start in Chopin on this machine";

function paths(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

/** The file the service's output is appended to. */
export function logPath(platform: NodeJS.Platform, directory: string) {
	return paths(platform).join(directory, "chopin.log");
}

/**
 * `chopin connect`'s arguments under the service. `--service` runs the settings install copied
 * into config.json and marks its lock as the service's.
 */
export function serviceArguments(program: ServiceProgram) {
	return ["connect", "--base-dir", program.directory, "--service"];
}

function control(character: string) {
	let code = character.charCodeAt(0);
	return code < 0x20 || code === 0x7f;
}

function hasControl(value: string) {
	return [...value].some(control);
}

/**
 * Why the service cannot name one of the program's paths, if it can't: each must be absolute and
 * free of control characters; systemd cannot run an executable whose path holds a quote or a
 * backslash; and Task Scheduler expands `%` anywhere in a task's command.
 */
export function unsupportedPath(platform: NodeJS.Platform, program: ServiceProgram) {
	let path = paths(platform);
	let named = {
		"chopin executable": program.executable,
		"state directory": program.directory,
	};
	for (let [what, value] of Object.entries(named)) {
		if (!path.isAbsolute(value)) return `The ${what} must be an absolute path, not "${value}".`;
		if (hasControl(value)) {
			return `The ${what} ${JSON.stringify(value)} holds a control character, which a service `
				+ "cannot name. Move it to a path without one.";
		}
	}
	if (platform === "linux" && /['"\\]/.test(program.executable)) {
		return [
			`systemd can't run ${JSON.stringify(program.executable)}, because its path holds a quote or`
			+ " a backslash. Nothing was installed. Copy chopin to a directory whose path has none,",
			"then install the service with that copy, for example:",
			`  sudo install -m 755 ${shellWord(program.executable)} /usr/local/bin/chopin`,
			"  /usr/local/bin/chopin service install",
		].join("\n");
	}
	let used = Object.values(named).find(value => value.includes("%"));
	if (platform === "win32" && used !== undefined) {
		return `Task Scheduler would expand the % in ${JSON.stringify(used)}. Nothing was installed. `
			+ "Use a chopin path and state directory without %.";
	}
	return undefined;
}

function shellWord(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * One quoted word of a systemd unit: C escapes, `%%` for a literal `%`, and in a command's
 * arguments `$$` for a literal `$`. systemd never expands variables in the executable or in
 * Environment=, so their `$` stays single.
 */
export function systemdQuote(value: string, context: "executable" | "argument" | "setting") {
	let escaped = [...value].map(character =>
		character === "\\" || character === '"'
			? `\\${character}`
			: character === "%"
			? "%%"
			: control(character)
			? `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
			: character
	).join("");
	return `"${context === "argument" ? escaped.replaceAll("$", "$$$$") : escaped}"`;
}

/** The systemd user unit for `program`, running with `path` as its PATH. */
export function systemdUnit(program: ServiceProgram, path: string) {
	let log = logPath("linux", program.directory).replaceAll("%", "%%");
	let command = [
		systemdQuote(program.executable, "executable"),
		...serviceArguments(program).map(word => systemdQuote(word, "argument")),
	];
	return [
		"[Unit]",
		`Description=${DESCRIPTION}`,
		`Documentation=${DOCUMENTATION}`,
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${command.join(" ")}`,
		"WorkingDirectory=~",
		`Environment=${systemdQuote(`PATH=${path}`, "setting")}`,
		"Restart=always",
		"RestartSec=5",
		"KillMode=mixed",
		`TimeoutStopSec=${STOP_SECONDS}`,
		`StandardOutput=append:${log}`,
		`StandardError=append:${log}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

function xml(value: string) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** The LaunchAgent for `program`, starting in `home` with `path` as its PATH. */
export function launchdPlist(program: ServiceProgram, home: string, path: string) {
	let string = (value: string) => `<string>${xml(value)}</string>`;
	let log = logPath("darwin", program.directory);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
		+ '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t${string(LABEL)}`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...[program.executable, ...serviceArguments(program)].map(word => `\t\t${string(word)}`),
		"\t</array>",
		"\t<key>WorkingDirectory</key>",
		`\t${string(home)}`,
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>PATH</key>",
		`\t\t${string(path)}`,
		"\t</dict>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<true/>",
		"\t<key>ThrottleInterval</key>",
		"\t<integer>10</integer>",
		"\t<key>ExitTimeOut</key>",
		`\t<integer>${STOP_SECONDS}</integer>`,
		"\t<key>ProcessType</key>",
		"\t<string>Interactive</string>",
		"\t<key>StandardOutPath</key>",
		`\t${string(log)}`,
		"\t<key>StandardErrorPath</key>",
		`\t${string(log)}`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

/** One argument of a Windows command line, quoted the way a program's C runtime splits it back. */
export function windowsArgument(value: string) {
	if (value !== "" && !/[\s"]/.test(value)) return value;
	let quoted = '"';
	let backslashes = 0;
	for (let character of value) {
		if (character === "\\") {
			backslashes++;
			continue;
		}
		quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/** A PowerShell single-quoted string; every character PowerShell reads as a single quote doubles. */
export function powershellLiteral(value: string) {
	return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
}

/**
 * A PowerShell expression for `value` without a double quote in its source, so the script passes
 * through powershell.exe's command line unchanged.
 */
function powershellString(value: string) {
	let pieces = value.split('"');
	return pieces.length === 1
		? powershellLiteral(value)
		: `(${pieces.map(powershellLiteral).join(" + [char]34 + ")})`;
}

function taskSelector(name: string) {
	return `-TaskName ${powershellLiteral(name)} -TaskPath '\\'`;
}

/** What the task runs: `execute` with the command line `argument`. */
export type TaskAction = { execute: string; argument: string };

/**
 * The task's action: cmd sets the service's PATH, then runs chopin. Task Scheduler cannot set a
 * variable itself. cmd reads & | < > ^ ( ) only outside double quotes, and every " toggles that,
 * so each one it would read there is escaped with ^; chopin then splits the line as written.
 * /d skips cmd's AutoRun commands, /v:off keeps ! literal, and a % is refused before this.
 */
export function taskAction(program: ServiceProgram, path: string, cmd: string): TaskAction {
	let run = [`"${program.executable}"`, ...serviceArguments(program).map(windowsArgument)]
		.join(" ");
	let quoted = false;
	let escaped = [...run].map(character => {
		if (character === '"') quoted = !quoted;
		return !quoted && /[&|<>^()]/.test(character) ? `^${character}` : character;
	}).join("");
	return { execute: cmd, argument: `/d /v:off /s /c "set "PATH=${path}" && ${escaped}"` };
}

/**
 * The PowerShell script that registers and starts this account's task `name`, running `action`:
 * at logon, in the user's session, restarted after a failure and never stopped for running too
 * long.
 */
export function scheduledTaskScript(action: TaskAction, home: string, name: string) {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
		`$action = New-ScheduledTaskAction -Execute ${powershellString(action.execute)}`
		+ ` -Argument ${powershellString(action.argument)}`
		+ ` -WorkingDirectory ${powershellString(home)}`,
		"$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user",
		"$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
		"$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)"
		+ " -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable"
		+ " -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
		`Register-ScheduledTask ${taskSelector(name)} -Description ${powershellLiteral(DESCRIPTION)}`
		+ " -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force"
		+ " | Out-Null",
		`Start-ScheduledTask ${taskSelector(name)}`,
	].join("; ");
}

/** How a program the service manager owns ended; code -1 when it could not start. */
export type Outcome = { code: number; stdout: string; stderr: string };

/** Runs `command` with `args` as given, never through a shell. */
export type Runner = (command: string, args: string[]) => Promise<Outcome>;

/** Everything installing, inspecting or removing the service touches outside its own files. */
export type ServiceHost = {
	platform: NodeJS.Platform;
	home: string;
	/** The login name, for loginctl and the Windows task's name. */
	user: string;
	/** The user id, for launchctl's gui/<uid> domain. */
	uid: number;
	env: Env;
	run: Runner;
	/** Finds `command` on a PATH; Bun.which unless a test supplies one. */
	which?: (command: string, path: string) => string | null;
	sleep?: (ms: number) => Promise<void>;
};

export type ServiceManager = "systemd" | "launchd" | "task-scheduler";

/** A refusal or failure to show the person as it is, with nothing else to add. */
export class ServiceError extends Error {
	override name = "ServiceError";
}

export const LINGER_COMMAND = 'sudo loginctl enable-linger "$(id -un)"';

const LOGON_NOTE = "It runs only while you are logged on to Windows. To start it at boot, "
	+ 'see "Run chopin as a service" in docs/local-experiments.md.';

/** Runs a program through execFile, so arguments are never split or expanded by a shell. */
export const runProcess: Runner = (command, args) =>
	new Promise(resolve => {
		execFile(command, args, {
			timeout: (STOP_SECONDS + 60) * 1000,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			let code = error ? (error as { code?: unknown }).code : 0;
			resolve({
				code: typeof code === "number" ? code : error ? -1 : 0,
				stdout: String(stdout),
				stderr: String(stderr) || (error && typeof code !== "number" ? error.message : ""),
			});
		});
	});

export function serviceManager(platform: NodeJS.Platform): ServiceManager {
	if (platform === "linux") return "systemd";
	if (platform === "darwin") return "launchd";
	if (platform === "win32") return "task-scheduler";
	throw new ServiceError(
		"chopin can run as a service on Linux (systemd), macOS (launchd) and Windows (Task "
			+ `Scheduler), not on ${platform}. Run chopin connect in a terminal instead.`,
	);
}

/** This account's own task, so each account on a machine manages only its own. */
export function taskName(user: string) {
	return `chopin-${
		user.replace(/[^A-Za-z0-9._-]/g, c => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
	}`;
}

/** The unit or plist file, or on Windows the task's path in Task Scheduler. */
export function definitionPath(host: ServiceHost) {
	let manager = serviceManager(host.platform);
	if (manager === "task-scheduler") return `\\${taskName(host.user)}`;
	if (manager === "launchd") {
		return posix.join(host.home, "Library", "LaunchAgents", `${LABEL}.plist`);
	}
	let config = host.env.XDG_CONFIG_HOME;
	return posix.join(
		config && posix.isAbsolute(config) ? config : posix.join(host.home, ".config"),
		"systemd",
		"user",
		UNIT,
	);
}

function why(outcome: Outcome) {
	return outcome.stderr.trim() || outcome.stdout.trim() || `exit code ${outcome.code}`;
}

/** A program in Windows' System32, under the system root named by the environment. */
function windowsSystem(env: Env, ...file: string[]) {
	let root =
		[env.SystemRoot, env.SYSTEMROOT, env.windir].find(value =>
			!!value && /^[A-Za-z]:\\[^%"]*$/.test(value) && !hasControl(value)
		) ?? "C:\\Windows";
	return win32.join(root, "System32", ...file);
}

/** The longest command line cmd runs. */
const CMD_LIMIT = 8191;

function powershell(host: ServiceHost, script: string) {
	return host.run(windowsSystem(host.env, "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script,
	]);
}

function pathVariable(host: ServiceHost) {
	let name = host.platform === "win32"
		? Object.keys(host.env).find(item => item.toUpperCase() === "PATH") ?? "Path"
		: "PATH";
	return host.env[name] ?? (host.platform === "win32" ? "" : DEFAULT_PATH);
}

/**
 * The interpreter a script's `#!` line names: a name `#!/usr/bin/env [-S]` finds on the PATH,
 * or an absolute path. Refuses a `#!` line the system would misread: one ending in a carriage
 * return, or one that names neither an absolute path nor `/usr/bin/env [-S] <name>`.
 */
async function interpreter(file: string) {
	let head = await Bun.file(file).slice(0, 256).text().catch(() => "");
	if (!head.startsWith("#!")) return undefined;
	let line = head.split("\n")[0]!;
	if (line.endsWith("\r")) {
		throw new ServiceError(
			`${file} has Windows line endings in its first line; convert it with dos2unix. Nothing `
				+ "was installed.",
		);
	}
	let viaEnv = line.match(/^#!\s*\/(?:\S*\/)?env\s+(?:-S\s+)?([^\s-]\S*)/)?.[1];
	let absolute = line.match(/^#!\s*(\/\S+)/)?.[1];
	let named = viaEnv ?? (absolute && posix.basename(absolute) !== "env" ? absolute : undefined);
	if (!named) {
		throw new ServiceError(
			`${file}'s #! line must name an absolute path or use /usr/bin/env [-S] <name>. Nothing `
				+ "was installed.",
		);
	}
	return named;
}

/**
 * Where `command` names the program it runs: after `env` and its VAR=VALUE assignments, when it
 * starts with `env` or an absolute path to it, else its first word.
 */
export function programAt(command: string[]) {
	let first = command[0] ?? "";
	if (first !== "env" && !(posix.isAbsolute(first) && posix.basename(first) === "env")) return 0;
	let at = 1;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[at] ?? "")) at++;
	return command[at] && !command[at]!.startsWith("-") ? at : 0;
}

function finder(host: ServiceHost) {
	return host.which ?? ((name: string, PATH: string) => Bun.which(name, { PATH }));
}

/** How many `#!` interpreters install follows from a script before it refuses the chain. */
const MAX_INTERPRETERS = 5;

/**
 * `servicePath` with the stable directory of the interpreter `file`'s `#!` line names, and of
 * each interpreter that one names in turn while it is a script too, wherever the service would
 * not find them yet. One found only through a directory gone after a reboot is refused, as is a
 * chain longer than `MAX_INTERPRETERS` or one that loops.
 */
async function withInterpreters(
	host: ServiceHost,
	file: string,
	what: string,
	servicePath: string,
) {
	if (host.platform === "win32") return servicePath;
	let which = finder(host);
	let chain = [file];
	for (;;) {
		let named = await interpreter(file);
		if (!named) return servicePath;
		if (chain.length > MAX_INTERPRETERS) {
			throw new ServiceError(
				`${chain[0]} runs through more than ${MAX_INTERPRETERS} #! interpreters (`
					+ `${[...chain, named].join(" → ")}). Nothing was installed. Point its #! line at `
					+ "the program that finally runs it.",
			);
		}
		let absolute = posix.isAbsolute(named);
		let found = absolute
			? which(named, servicePath)
			: which(named, servicePath) ?? which(named, pathVariable(host));
		if (!found) {
			throw new ServiceError(
				[
					`The service would not find ${named}, which ${what} runs with, under the PATH it runs `
					+ "with:",
					`  ${servicePath}`,
					`Nothing was installed. Install ${named} somewhere stable and make sure it is on your PATH.`,
				].join("\n"),
			);
		}
		let passed = await links(host.platform, found);
		refuseFleeting(
			host,
			passed,
			`${named}, which ${what} runs with,`,
			`Install ${named} somewhere stable, or link it into a directory on the service's PATH:\n`
				+ `  ${servicePath}`,
		);
		if (chain.includes(passed[0]!)) {
			throw new ServiceError(
				`${chain[0]}'s #! interpreters loop (${[...chain, passed[0]].join(" → ")}), so it never `
					+ "reaches a program to run. Nothing was installed. Fix the #! lines.",
			);
		}
		if (!absolute && !which(named, servicePath)) {
			servicePath += posix.delimiter + posix.dirname(passed[0]!);
		}
		chain.push(passed[0]!);
		file = passed[0]!;
		what = named;
	}
}

/**
 * What the service would make of the program at `found`: undefined when it lies in no directory
 * that lasts only as long as a login or a shell; its stable path when it reaches one only
 * through such a directory, as a version manager's per-shell link does; else the path that
 * lies in one, which install refuses.
 */
export async function stablePath(platform: NodeJS.Platform, env: Env, found: string) {
	let temporary = temporaryPath(platform, env);
	let passed = await links(platform, found);
	let fleeting = passed.find(temporary);
	if (fleeting !== undefined) return { fleeting };
	let through = (await walk(platform, paths(platform).dirname(found))).hops;
	return temporary(found) || through.some(temporary) ? { stable: passed[0]! } : undefined;
}

/** The target of the link at `entry`, or undefined when it is not a link. */
async function linkTarget(entry: string) {
	let stats = await lstat(entry).catch(() => undefined);
	return stats?.isSymbolicLink() ? await readlink(entry).catch(() => undefined) : undefined;
}

/**
 * Follows `start` a component at a time, as opening it does: each link on the way, to a file or a
 * directory, is read where it lies, and a relative target resolves against the link's own
 * directory. Returns the links passed, in order, and the path they end at.
 */
async function walk(platform: NodeJS.Platform, start: string) {
	let path = paths(platform);
	let split = (value: string) =>
		value.slice(path.parse(value).root.length).split(platform === "win32" ? /[\\/]+/ : /\/+/)
			.filter(Boolean);
	let reached = path.parse(start).root;
	let rest = split(start);
	let hops: string[] = [];
	while (rest.length) {
		let part = rest.shift()!;
		if (part === ".") continue;
		if (part === "..") {
			reached = path.dirname(reached);
			continue;
		}
		let entry = path.join(reached, part);
		// Past 40 links, as the system gives up, the rest is taken as it reads.
		let target = hops.length < 40 ? await linkTarget(entry) : undefined;
		if (target === undefined) {
			reached = entry;
			continue;
		}
		hops.push(entry);
		if (path.isAbsolute(target)) reached = path.parse(path.resolve(reached, target)).root;
		rest.unshift(...split(target));
	}
	return { hops, end: reached };
}

/**
 * The paths `file` goes through to reach what it runs: first `file` itself in its directory with
 * links resolved, which keeps the file's own name that shims such as mise's and Volta's dispatch
 * on, then every link the service passes from there, file or directory, and last where they end.
 */
async function links(platform: NodeJS.Platform, file: string) {
	let path = paths(platform);
	let first = path.join((await walk(platform, path.dirname(file))).end, path.basename(file));
	let { hops, end } = await walk(platform, first);
	return [first, ...hops, end];
}

/** Refuses a program that is, or links through, a path gone after a reboot. */
function refuseFleeting(host: ServiceHost, passed: string[], what: string, fix: string) {
	let fleeting = passed.find(temporaryPath(host.platform, host.env));
	if (fleeting === undefined) return;
	throw new ServiceError(
		[
			`${what} is, or links through, ${fleeting}, which lies in a directory that lasts only as `
			+ "long as this login or shell, so the service would not find it after a reboot. Nothing "
			+ "was installed.",
			fix,
		].join("\n"),
	);
}

/**
 * The agent's command with stable absolute paths, and the PATH the service runs with, once the
 * agent (the program behind `env` when it is wrapped in one), the interpreters its script names
 * and git all resolve under it to paths that outlast this login and shell; otherwise a refusal,
 * before anything is written.
 */
async function agentPath(host: ServiceHost, command: string[]) {
	let which = finder(host);
	let path = paths(host.platform);
	let at = programAt(command);
	let resolved = [...command];
	for (let index of new Set([0, at])) {
		let word = command[index]!;
		let found = which(word, pathVariable(host));
		if (!found) {
			throw new ServiceError(
				`The agent command ${word} is not on your PATH. Nothing was installed. `
					+ "Run chopin connect again with the agent's absolute path after --.",
			);
		}
		// A per-shell directory is often a link into a version manager's stable one.
		let passed = await links(host.platform, found);
		refuseFleeting(
			host,
			passed,
			`The agent command ${word}`,
			"Install the agent somewhere stable, or run chopin connect again with a stable absolute "
				+ "path to it after --.",
		);
		resolved[index] = passed[0]!;
	}
	let agent = command[at]!;
	let stable = resolved[at]!;
	let service = await withInterpreters(
		host,
		stable,
		agent,
		servicePath(host.platform, host.env, path.dirname(stable)),
	);
	let git = which("git", service);
	if (!git) {
		throw new ServiceError(
			[
				"The service would not find git under the PATH it runs with:",
				`  ${service}`,
				"Nothing was installed. That PATH leaves out directories that last only as long as "
				+ "this login or shell. Install git outside them.",
			].join("\n"),
		);
	}
	refuseFleeting(
		host,
		await links(host.platform, git),
		"git",
		"Install git somewhere stable, outside those directories.",
	);
	return { path: service, command: resolved };
}

function release(version: string) {
	return /^\d+\.\d+\.\d+/.test(version);
}

/** Whether the service manager has the service, whatever state it is in. */
async function installed(host: ServiceHost) {
	if (serviceManager(host.platform) !== "task-scheduler") return existsSync(definitionPath(host));
	return !!await taskState(host);
}

async function writeDefinition(path: string, text: string) {
	try {
		await mkdir(posix.dirname(path), { recursive: true });
		await writeFile(path, text, { mode: 0o644 });
	} catch (error) {
		throw new ServiceError(
			`chopin couldn't write ${path}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

export type Installed = {
	manager: ServiceManager;
	definition: string;
	log: string;
	notes: string[];
};

/**
 * The PATH the service runs with, once the Planner backend (the program behind `env` when it is
 * wrapped in one) and the interpreters its script names resolve under it, adding their stable
 * directories where needed; otherwise a refusal. A relative path resolves in the checkout,
 * where `connect` starts the backend.
 */
async function checkPlanners(host: ServiceHost, settings: ConnectSettings, servicePath: string) {
	let command = settings.plannerCommand;
	let planner = command[programAt(command)];
	if (!settings.planners.length || !planner) return servicePath;
	let refuse = (why: string) => new ServiceError(`${why} Nothing was installed.`);
	let path = paths(host.platform);
	let named = /[\\/]/.test(planner) ? path.resolve(settings.checkout, planner) : planner;
	let found = finder(host)(named, servicePath);
	if (!found) {
		throw refuse(
			`The service would not find the Planner command ${planner} under the PATH it runs with:\n`
				+ `  ${servicePath}\nInstall it there, or give its absolute path in --planner-command.`,
		);
	}
	let passed = await links(host.platform, found);
	refuseFleeting(
		host,
		passed,
		`The Planner command ${planner}`,
		"Install it somewhere stable, or give a stable absolute path to it in --planner-command.",
	);
	return withInterpreters(host, passed[0]!, `the Planner command ${planner}`, servicePath);
}

/**
 * Refuses an agent that doesn't answer ACP initialize within 10 seconds when started as the
 * service starts it: with the service's PATH and the saved --env, and on Linux and macOS without
 * the rest of this shell's environment.
 */
async function checkStart(host: ServiceHost, settings: ConnectSettings, path: string) {
	let windows = host.platform === "win32";
	let name = windows
		? Object.keys(host.env).find(item => item.toUpperCase() === "PATH") ?? "Path"
		: "PATH";
	let env = {
		...(windows ? host.env : { HOME: host.home, USER: host.user, LOGNAME: host.user }),
		[name]: path,
		...settings.env,
	};
	let failed = await checkAgent(settings.command, { cwd: host.home, env });
	if (!failed) return;
	let agent = settings.command[programAt(settings.command)];
	throw new ServiceError(
		[
			`${agent} didn't answer ACP initialize when started as the service would start it (`
			+ `${redacted(failed.how)}${
				failed.stderr ? `: ${redacted(failed.stderr).slice(0, 200)}` : ""
			}). Nothing was installed.`,
			"Fix that and install again. For an agent that can't start without a terminal, pass "
			+ "--skip-check.",
		].join("\n"),
	);
}

/**
 * Install `program` as this user's service and start it, so it starts again by itself. It copies
 * what the last `chopin connect` ran, checked here first, server included, into config.json as
 * the service's own settings, which a later connect leaves alone. With `check`, it first starts
 * the agent as the service would and refuses one that doesn't answer ACP initialize. A service
 * an older chopin than one already installed is refused without `allowDowngrade`.
 */
export async function installService(
	host: ServiceHost,
	program: ServiceProgram,
	options: { allowDowngrade?: boolean; version?: string; check?: boolean } = {},
): Promise<Installed> {
	let manager = serviceManager(host.platform);
	let version = options.version ?? VERSION;
	let config = await readConfig(program.directory);
	let settings = config.connect;
	if (!settings) throw new ServiceError(CONNECT_FIRST);
	let resolved = await agentPath(host, settings.command);
	// The service runs the agent by its stable path, not one through a shell's own links.
	settings = { ...settings, command: resolved.command };
	let unusable = unsupportedPath(host.platform, program);
	if (unusable) throw new ServiceError(unusable);
	let path = await checkPlanners(host, settings, resolved.path);
	if (manager === "launchd" && hasControl(path)) {
		throw new ServiceError(
			"The PATH holds a control character, which a LaunchAgent cannot hold. Nothing was "
				+ "installed.",
		);
	}
	if (options.check) await checkStart(host, settings, path);
	let previous = config.service?.version;
	if (
		!options.allowDowngrade && previous && release(previous) && release(version)
		&& Bun.semver.order(previous, version) > 0 && await installed(host)
	) {
		throw new ServiceError(
			`The installed service was set up by chopin ${previous}, which is newer than this chopin `
				+ `${version}. Nothing was changed. Run \`chopin update\` first, or pass `
				+ "--allow-downgrade to replace it anyway.",
		);
	}
	let definition = definitionPath(host);
	let log = logPath(host.platform, program.directory);
	let record = () =>
		updateConfig(program.directory, value => {
			// The agent by its resolved path in both, so status can tell when connect ran since.
			value.connect = settings;
			value.service = { ...program, version, installedAt: Date.now(), settings };
		});
	let notes: string[] = [];
	if (manager === "systemd") {
		let shown = await host.run("systemctl", ["--user", "show", "--property=Version"]);
		if (shown.code !== 0) {
			throw new ServiceError(
				`chopin can't reach your systemd user manager (${why(shown)}). Nothing was installed. `
					+ "Run systemctl --user status in a login session as this user; over SSH, log in as "
					+ "that user directly rather than through su or sudo.",
			);
		}
		let linger = await host.run("loginctl", [
			"show-user",
			host.user,
			"--property=Linger",
			"--value",
		]);
		if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
			let enabled = await host.run("loginctl", ["--no-ask-password", "enable-linger", host.user]);
			if (enabled.code !== 0) {
				throw new ServiceError(
					[
						`The service has to keep running after you log out, which needs linger for ${host.user}, `
						+ `and enabling it needs an administrator (${why(enabled)}). Nothing was installed.`,
						"Have an administrator run this once, then run chopin service install again:",
						`  ${LINGER_COMMAND}`,
						"Run only that command with sudo, never chopin itself.",
					].join("\n"),
				);
			}
		}
		let active = await host.run("systemctl", ["--user", "is-active", UNIT]);
		await record();
		await writeDefinition(definition, systemdUnit(program, path));
		let steps = [["daemon-reload"], ["enable", "--now", UNIT]];
		// enable --now leaves a running service on its old definition.
		if (active.stdout.trim() === "active") steps.push(["restart", UNIT]);
		for (let step of steps) {
			let done = await host.run("systemctl", ["--user", ...step]);
			if (done.code !== 0) {
				throw new ServiceError(
					`systemctl --user ${step.join(" ")} failed: ${why(done)}. The unit is written to `
						+ `${definition}.`,
				);
			}
		}
	} else if (manager === "launchd") {
		let target = `gui/${host.uid}/${LABEL}`;
		await record();
		await writeDefinition(definition, launchdPlist(program, host.home, path));
		if ((await host.run("launchctl", ["print", target])).code === 0) {
			let unloaded = await host.run("launchctl", ["bootout", target]);
			if (unloaded.code !== 0) {
				throw new ServiceError(`launchctl bootout ${target} failed: ${why(unloaded)}`);
			}
		}
		await host.run("launchctl", ["enable", target]);
		let loaded = await host.run("launchctl", ["bootstrap", `gui/${host.uid}`, definition]);
		if (loaded.code !== 0) {
			throw new ServiceError(
				`launchctl bootstrap gui/${host.uid} couldn't load ${definition}: ${why(loaded)}. `
					+ "Over SSH with nobody logged in at the Mac there is no session to load it into; "
					+ "it loads at your next login.",
			);
		}
	} else {
		let action = taskAction(program, path, windowsSystem(host.env, "cmd.exe"));
		if (action.execute.length + 1 + action.argument.length > CMD_LIMIT) {
			throw new ServiceError(
				`The task's command line, with the PATH it sets, would be longer than the ${CMD_LIMIT} `
					+ "characters cmd runs. Nothing was installed. Shorten your PATH.",
			);
		}
		let before = await taskState(host);
		await record();
		if (before?.state === "Running") {
			await stopTask(host, program.directory);
		}
		let registered = await powershell(
			host,
			scheduledTaskScript(action, host.home, taskName(host.user)),
		);
		if (registered.code !== 0) {
			throw new ServiceError(
				`Task Scheduler didn't register the ${definition} task: ${why(registered)}`,
			);
		}
		notes.push(LOGON_NOTE);
	}
	return { manager, definition, log, notes };
}

type TaskState = { state: string; lastResult?: number };

function taskStatusScript(name: string) {
	let task = taskSelector(name);
	return [
		`$task = Get-ScheduledTask ${task} -ErrorAction SilentlyContinue`,
		`if ($null -eq $task) { 'not-installed' } else { $info = Get-ScheduledTaskInfo ${task}; `
		+ "[pscustomobject]@{ state = [string]$task.State; lastResult = $info.LastTaskResult } "
		+ "| ConvertTo-Json -Compress }",
	].join("; ");
}

/** Reads the status script's answer: the task's state, or undefined when there is no task. */
export function parseTask(text: string): TaskState | undefined {
	let trimmed = text.trim();
	if (trimmed === "not-installed") return undefined;
	let parsed: { state?: unknown; lastResult?: unknown };
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new ServiceError(`Task Scheduler answered something chopin can't read: ${trimmed}`);
	}
	return {
		state: typeof parsed.state === "string" ? parsed.state : "Unknown",
		...(typeof parsed.lastResult === "number" ? { lastResult: parsed.lastResult } : {}),
	};
}

async function taskState(host: ServiceHost) {
	let outcome = await powershell(host, taskStatusScript(taskName(host.user)));
	if (outcome.code !== 0) {
		throw new ServiceError(
			`Task Scheduler couldn't be asked about the ${definitionPath(host)} task: ${why(outcome)}`,
		);
	}
	return parseTask(outcome.stdout);
}

/** The file a Windows service connector watches for a request to stop; it holds its pid. */
export function stopFile(directory: string) {
	return join(directory, "stop");
}

/**
 * Ask the service's connector to report its runs stopped and exit, as SIGTERM does on Linux and
 * macOS: Task Scheduler ends a task without a signal. Waits up to STOP_SECONDS for it to exit.
 */
async function requestStop(host: ServiceHost, directory: string) {
	let probe = processStart(host.platform, host.run);
	let held = (await connectors(directory, probe)).find(item => item.service && item.running);
	if (!held) return "not-running";
	let sleep = host.sleep ?? Bun.sleep;
	await writeFile(stopFile(directory), `${held.pid}\n`, { mode: 0o600 });
	try {
		for (let waited = 0; waited < STOP_SECONDS; waited++) {
			if (
				!(await connectors(directory, probe)).some(item => item.pid === held.pid && item.running)
			) {
				return "stopped";
			}
			await sleep(1000);
		}
		return "ended";
	} finally {
		await rm(stopFile(directory), { force: true });
	}
}

/** Stops the task once its connector had its chance to stop by itself. */
async function stopTask(host: ServiceHost, directory: string) {
	await requestStop(host, directory);
	let task = taskSelector(taskName(host.user));
	let stopped = await powershell(
		host,
		`$task = Get-ScheduledTask ${task} -ErrorAction SilentlyContinue; `
			+ `if ($null -ne $task -and [string]$task.State -eq 'Running') { Stop-ScheduledTask ${task} }`,
	);
	if (stopped.code !== 0) {
		throw new ServiceError(
			`Task Scheduler couldn't stop the ${definitionPath(host)} task: ${why(stopped)}`,
		);
	}
}

export type ServiceState = "running" | "stopped" | "restart-pending" | "not-installed";

export type ServiceStatus = {
	state: ServiceState;
	manager: ServiceManager;
	/** The unit or plist file, or the task's path in Task Scheduler. */
	definition: string;
	log: string;
	pid?: number;
	/** The chopin version the service's connector runs, and the one installed at its path. */
	running?: string;
	installed?: string;
	notes: string[];
};

function values(text: string, line: RegExp) {
	return new Map([...text.matchAll(line)].map(match => [match[1]!, match[2]!.trim()] as const));
}

/** Reads `systemctl --user show` output. */
export function parseSystemd(text: string) {
	let shown = values(text, /^(\w+)=(.*)$/gm);
	let pid = Number(shown.get("MainPID") ?? 0);
	return {
		running: shown.get("ActiveState") === "active",
		enabled: shown.get("UnitFileState") === "enabled",
		restarting: shown.get("SubState") === "auto-restart",
		...(pid > 0 ? { pid } : {}),
	};
}

/** Reads the top level of `launchctl print` output. */
export function parseLaunchctl(text: string) {
	let shown = values(text, /^\t([a-z][\w ]*?) = (.*)$/gm);
	let pid = Number(shown.get("pid") ?? 0);
	let exit = shown.get("last exit code");
	return {
		running: shown.get("state") === "running",
		...(pid > 0 ? { pid } : {}),
		...(exit ? { exit } : {}),
	};
}

/** The version a chopin executable reports, or undefined when it can't be run. */
async function executableVersion(host: ServiceHost, executable: string) {
	let outcome = await host.run(executable, ["--version"]);
	return outcome.code === 0 ? outcome.stdout.match(/^chopin (\S+)/)?.[1] : undefined;
}

/**
 * Whether the service is installed and running, and whether its connector runs the chopin now
 * installed at its path: after `chopin update` it is restart-pending until it restarts.
 */
export async function serviceStatus(host: ServiceHost, directory: string): Promise<ServiceStatus> {
	let manager = serviceManager(host.platform);
	let definition = definitionPath(host);
	let log = logPath(host.platform, directory);
	let base = { manager, definition, log };
	let status: ServiceStatus;
	if (manager === "systemd") {
		if (!existsSync(definition)) return { ...base, state: "not-installed", notes: [] };
		let shown = await host.run("systemctl", [
			"--user",
			"show",
			UNIT,
			"--property=LoadState,ActiveState,SubState,UnitFileState,MainPID",
		]);
		if (shown.code !== 0) {
			throw new ServiceError(`chopin can't reach your systemd user manager (${why(shown)}).`);
		}
		let unit = parseSystemd(shown.stdout);
		let linger = await host.run("loginctl", [
			"show-user",
			host.user,
			"--property=Linger",
			"--value",
		]);
		let notes = [
			...(!unit.enabled ? ["It is not enabled; chopin service install enables it."] : []),
			...(linger.stdout.trim() === "yes" ? [] : [
				"Linger is off, so it starts when you log in and stops when you log out; "
				+ `${LINGER_COMMAND} makes it start at boot.`,
			]),
			...(unit.restarting
				? ["It exited, and systemd starts it again in a few seconds; the log says why."]
				: []),
		];
		status = {
			...base,
			state: unit.running ? "running" : "stopped",
			notes,
			...(unit.pid ? { pid: unit.pid } : {}),
		};
	} else if (manager === "launchd") {
		if (!existsSync(definition)) return { ...base, state: "not-installed", notes: [] };
		let printed = await host.run("launchctl", ["print", `gui/${host.uid}/${LABEL}`]);
		if (printed.code !== 0) {
			return {
				...base,
				state: "stopped",
				notes: [
					"It is not loaded: it loads at your next login, or now with chopin service restart.",
				],
			};
		}
		let agent = parseLaunchctl(printed.stdout);
		status = {
			...base,
			state: agent.running ? "running" : "stopped",
			notes: agent.running || !agent.exit
				? []
				: [`It last exited with ${agent.exit}; launchd starts it again, and the log says why.`],
			...(agent.pid ? { pid: agent.pid } : {}),
		};
	} else {
		let task = await taskState(host);
		if (!task) return { ...base, state: "not-installed", notes: [] };
		status = {
			...base,
			state: task.state === "Running" ? "running" : "stopped",
			notes: [
				...(task.state === "Disabled"
					? ["The task is disabled; chopin service install enables it again."]
					: []),
				...(task.state !== "Running" && task.lastResult
					? [`It last ended with result ${task.lastResult}; the log says why.`]
					: []),
				LOGON_NOTE,
			],
		};
	}
	if (status.state !== "running") return status;
	let executable = (await readConfig(directory)).service?.executable;
	let connector = (await connectors(directory, processStart(host.platform, host.run))).find(item =>
		item.service && item.running
	);
	let installedVersion = executable ? await executableVersion(host, executable) : undefined;
	if (connector?.version) status.running = connector.version;
	if (installedVersion) status.installed = installedVersion;
	if (status.running && status.installed && status.running !== status.installed) {
		status.state = "restart-pending";
		status.notes.push(
			`It runs chopin ${status.running}, but ${status.installed} is installed; `
				+ "chopin service restart runs it.",
		);
	}
	return status;
}

function notInstalled(): never {
	throw new ServiceError("chopin's service is not installed. Run chopin service install.");
}

/** Restart the service, so it runs the definition and chopin installed now. */
export async function restartService(host: ServiceHost, directory: string) {
	let manager = serviceManager(host.platform);
	let definition = definitionPath(host);
	if (manager === "systemd") {
		if (!existsSync(definition)) notInstalled();
		let restarted = await host.run("systemctl", ["--user", "restart", UNIT]);
		if (restarted.code !== 0) {
			throw new ServiceError(`systemctl --user restart ${UNIT} failed: ${why(restarted)}`);
		}
	} else if (manager === "launchd") {
		if (!existsSync(definition)) notInstalled();
		let target = `gui/${host.uid}/${LABEL}`;
		if ((await host.run("launchctl", ["print", target])).code === 0) {
			let unloaded = await host.run("launchctl", ["bootout", target]);
			if (unloaded.code !== 0) {
				throw new ServiceError(`launchctl bootout ${target} failed: ${why(unloaded)}`);
			}
		}
		let loaded = await host.run("launchctl", ["bootstrap", `gui/${host.uid}`, definition]);
		if (loaded.code !== 0) {
			throw new ServiceError(`launchctl bootstrap gui/${host.uid} failed: ${why(loaded)}`);
		}
	} else {
		if (!await taskState(host)) notInstalled();
		await stopTask(host, directory);
		let started = await powershell(
			host,
			`Start-ScheduledTask ${taskSelector(taskName(host.user))}`,
		);
		if (started.code !== 0) {
			throw new ServiceError(
				`Task Scheduler couldn't start the ${definition} task: ${why(started)}`,
			);
		}
	}
	return { manager, definition };
}

/**
 * Stop the service and remove it. The pairing in machine.json, config.json, the runs and the log
 * stay where they are.
 */
export async function uninstallService(host: ServiceHost, directory: string) {
	let manager = serviceManager(host.platform);
	let definition = definitionPath(host);
	let notes: string[] = [];
	let remove = async () => {
		try {
			await rm(definition, { force: true });
		} catch (error) {
			throw new ServiceError(
				`chopin couldn't remove ${definition}: ${error instanceof Error ? error.message : error}`,
			);
		}
	};
	if (manager === "systemd") {
		if (!existsSync(definition)) return { manager, definition, removed: false, notes };
		let disabled = await host.run("systemctl", ["--user", "disable", "--now", UNIT]);
		if (disabled.code !== 0) {
			throw new ServiceError(
				`systemctl --user disable --now ${UNIT} failed: ${why(disabled)}. Nothing was removed.`,
			);
		}
		await remove();
		await host.run("systemctl", ["--user", "daemon-reload"]);
		notes.push(
			'Linger stays as it was; sudo loginctl disable-linger "$(id -un)" turns it off if '
				+ "nothing else needs it.",
		);
	} else if (manager === "launchd") {
		if (!existsSync(definition)) return { manager, definition, removed: false, notes };
		let target = `gui/${host.uid}/${LABEL}`;
		if ((await host.run("launchctl", ["print", target])).code === 0) {
			let unloaded = await host.run("launchctl", ["bootout", target]);
			if (unloaded.code !== 0) {
				throw new ServiceError(
					`launchctl bootout ${target} failed: ${why(unloaded)}. Nothing was removed.`,
				);
			}
		}
		await remove();
	} else {
		if (!await taskState(host)) return { manager, definition, removed: false, notes };
		await stopTask(host, directory);
		let task = taskSelector(taskName(host.user));
		let removed = await powershell(host, `Unregister-ScheduledTask ${task} -Confirm:$false`);
		if (removed.code !== 0) {
			throw new ServiceError(
				`Task Scheduler couldn't remove the ${definition} task: ${why(removed)}`,
			);
		}
	}
	notes.push(`The pairing, config.json and runs in ${directory} stay in place.`);
	return { manager, definition, removed: true, notes };
}

/** The chopin and base dir an installed service definition runs. */
export type InstalledRun = { executable: string; directory: string };

/** Reads `<chopin> connect --base-dir <dir> --service` back from a definition's words. */
function runOf(words: string[]): InstalledRun | undefined {
	let at = words.indexOf("--base-dir");
	let [executable, verb] = words;
	let directory = at < 0 ? undefined : words[at + 1];
	return executable && verb === "connect" && directory ? { executable, directory } : undefined;
}

/** Reads the run back from a systemd unit's ExecStart, undoing systemdQuote. */
export function parseUnitRun(text: string) {
	let line = text.match(/^ExecStart=(.*)$/m)?.[1];
	if (!line) return undefined;
	let words = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match, index) => {
		let value = match[1]!.replaceAll("%%", "%");
		if (index > 0) value = value.replaceAll("$$", () => "$");
		return value.replace(
			/\\x([0-9a-fA-F]{2})|\\(.)/g,
			(_, hex: string | undefined, character) =>
				hex ? String.fromCharCode(Number.parseInt(hex, 16)) : character,
		);
	});
	return runOf(words);
}

/** Reads the run back from a LaunchAgent's ProgramArguments. */
export function parsePlistRun(text: string) {
	let array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
	if (array === undefined) return undefined;
	let entities: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
	let words = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match =>
		match[1]!.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => entities[name]!)
	);
	return runOf(words);
}

/** Splits a Windows command line the way a program's C runtime does. */
function windowsSplit(line: string) {
	let words: string[] = [];
	let word: string | undefined;
	let quoted = false;
	let index = 0;
	while (index < line.length) {
		if (!quoted && /\s/.test(line[index]!)) {
			if (word !== undefined) words.push(word);
			word = undefined;
			index++;
			continue;
		}
		let slashes = 0;
		while (line[index] === "\\") {
			slashes++;
			index++;
		}
		word = (word ?? "") + "\\".repeat(line[index] === '"' ? Math.floor(slashes / 2) : slashes);
		if (line[index] === '"') {
			if (slashes % 2) word += '"';
			else quoted = !quoted;
			index++;
		} else if (!slashes && index < line.length) {
			word += line[index++];
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

/** Reads the run back from a task's action, built by taskAction or running chopin directly. */
export function parseTaskRun(execute: string, argument: string) {
	let inner = argument.match(/^\/d \/v:off \/s \/c "([\s\S]*)"$/)?.[1];
	if (inner === undefined) return runOf([execute, ...windowsSplit(argument)]);
	let quoted = false;
	let line = "";
	for (let index = 0; index < inner.length; index++) {
		let character = inner[index]!;
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === "^") character = inner[++index] ?? "";
		line += character;
	}
	let run = line.match(/^set "PATH=[^"]*" && ([\s\S]*)$/)?.[1];
	return run === undefined ? undefined : runOf(windowsSplit(run));
}

function taskActionScript(name: string) {
	return [
		`$task = Get-ScheduledTask ${taskSelector(name)} -ErrorAction SilentlyContinue`,
		"if ($null -eq $task) { 'not-installed' } else { $action = @($task.Actions)[0]; "
		+ "[pscustomobject]@{ execute = [string]$action.Execute; arguments = [string]$action.Arguments } "
		+ "| ConvertTo-Json -Compress }",
	].join("; ");
}

/**
 * The chopin and base dir the installed service runs, read from its unit, plist or task rather
 * than config.json, which another base dir's install may have outdated; undefined when its
 * definition says something else.
 */
async function installedRun(
	host: ServiceHost,
): Promise<InstalledRun | "not-installed" | undefined> {
	if (serviceManager(host.platform) === "task-scheduler") {
		let outcome = await powershell(host, taskActionScript(taskName(host.user)));
		if (outcome.code !== 0) {
			throw new ServiceError(
				`Task Scheduler couldn't be asked about the ${definitionPath(host)} task: ${why(outcome)}`,
			);
		}
		let text = outcome.stdout.trim();
		if (text === "not-installed") return "not-installed";
		let action: { execute?: unknown; arguments?: unknown };
		try {
			action = JSON.parse(text);
		} catch {
			return undefined;
		}
		return typeof action.execute === "string" && typeof action.arguments === "string"
			? parseTaskRun(action.execute, action.arguments)
			: undefined;
	}
	let definition = definitionPath(host);
	if (!existsSync(definition)) return "not-installed";
	let text = await readFile(definition, "utf8");
	return host.platform === "darwin" ? parsePlistRun(text) : parseUnitRun(text);
}

function samePath(platform: NodeJS.Platform, one: string, other: string) {
	return pathKey(platform, one) === pathKey(platform, other);
}

/**
 * After `chopin update` replaced `executable`, restart a running service whose definition runs
 * that chopin with this base dir, so it is not left restart-pending. A service that runs another
 * chopin or base dir is left alone. Returns what to tell the person, if anything; a failed
 * restart does not undo the update.
 */
export async function restartAfterUpdate(host: ServiceHost, directory: string, executable: string) {
	if (!["linux", "darwin", "win32"].includes(host.platform)) return undefined;
	let run;
	try {
		run = await installedRun(host);
	} catch (error) {
		return `Could not check which chopin the service runs (${
			error instanceof Error ? error.message : error
		}). If it runs this one, run chopin service restart.`;
	}
	if (run === "not-installed") return undefined;
	if (
		!run || !samePath(host.platform, run.executable, executable)
		|| !samePath(host.platform, run.directory, directory)
	) {
		return `The chopin service runs a different chopin${
			run ? ` (${run.executable} with base dir ${run.directory})` : ""
		}, so this update left it alone.`;
	}
	try {
		let status = await serviceStatus(host, directory);
		if (status.state !== "running" && status.state !== "restart-pending") return undefined;
		await restartService(host, directory);
		return "Restarted the chopin service, so it runs the new chopin.";
	} catch (error) {
		return `Could not restart the chopin service (${
			error instanceof Error ? error.message : error
		}). Run chopin service restart.`;
	}
}

/**
 * Call `stop` once the stop request names this process, as `service restart` and `uninstall`
 * write it on Windows. Returns a function that stops watching.
 */
export function onStopRequest(directory: string, stop: () => void, intervalMs = 1000) {
	let file = stopFile(directory);
	let timer = setInterval(async () => {
		let pid = await Bun.file(file).text().catch(() => "");
		if (pid.trim() === String(process.pid)) {
			clearInterval(timer);
			stop();
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** This machine and user, with the real service manager behind runProcess. */
export function systemHost(): ServiceHost {
	return {
		platform: process.platform,
		home: homedir(),
		user: userInfo().username,
		uid: process.getuid?.() ?? -1,
		env: process.env,
		run: runProcess,
	};
}
