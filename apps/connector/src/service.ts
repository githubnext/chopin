import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { execFile } from "node:child_process";
import { readConfig, updateConfig } from "./config";
import { VERSION } from "./version";
import { connectors } from "./workspace";

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
 * The PATH the service runs with: the agent executable's directory first, so the agent and a
 * Node or Bun installed beside it resolve after a reboot, then this shell's own entries without
 * empty ones, repeats, or directories that last only as long as a login or a shell: those under
 * $XDG_RUNTIME_DIR or /run/user, and per-shell version-manager directories.
 */
export function servicePath(platform: NodeJS.Platform, env: Env, agentDirectory: string) {
	let windows = platform === "win32";
	let path = windows ? win32 : posix;
	let key = (entry: string) => {
		let trimmed = entry.replace(windows ? /[\\/]+$/ : /\/+$/, "") || entry;
		return windows ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
	};
	let runtime = [env.XDG_RUNTIME_DIR, ...(windows ? [] : ["/run/user"])]
		.filter((value): value is string => !!value && path.isAbsolute(value))
		.map(key)
		.filter(value => value !== key(path.parse(value).root));
	let temporary = (entry: string) => {
		let value = key(entry);
		let separator = windows ? "\\" : "/";
		return runtime.some(directory => value === directory || value.startsWith(directory + separator))
			|| value.split(separator).some(part => PER_SHELL.has(part));
	};
	let name = windows
		? Object.keys(env).find(item => item.toUpperCase() === "PATH") ?? "Path"
		: "PATH";
	let inherited = env[name] ?? (windows ? "" : DEFAULT_PATH);
	let kept = new Map<string, string>([[key(agentDirectory), agentDirectory]]);
	for (let entry of inherited.split(path.delimiter)) {
		if (entry && !kept.has(key(entry)) && !temporary(entry)) kept.set(key(entry), entry);
	}
	return [...kept.values()].join(path.delimiter);
}

/** What the service runs: the installed chopin, connecting a checkout with an agent command. */
export type ServiceProgram = {
	/** The absolute path of the installed chopin. */
	executable: string;
	/** The checkout's absolute root. */
	checkout: string;
	/** The agent's ACP command, as `connect` takes it after `--`. */
	command: string[];
	/** The state directory, passed as `--base-dir`; machine.json, locks and the log live there. */
	directory: string;
};

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

/** `chopin connect`'s arguments under the service; `--service` marks its lock as the service's. */
export function serviceArguments(program: ServiceProgram) {
	return [
		"connect",
		program.checkout,
		"--base-dir",
		program.directory,
		"--service",
		"--",
		...program.command,
	];
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
		checkout: program.checkout,
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
			"  /usr/local/bin/chopin service install …",
		].join("\n");
	}
	if (platform === "win32") {
		let used = [program.executable, ...serviceArguments(program)].find(value =>
			value.includes("%")
		);
		if (used !== undefined) {
			return `Task Scheduler would expand the % in ${JSON.stringify(used)}. Nothing was installed. `
				+ "Use a checkout, state directory and agent command without %.";
		}
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

/**
 * The PowerShell script that registers and starts this account's task `name`: at logon, in the
 * user's session, restarted after a failure and never stopped for running too long.
 */
export function scheduledTaskScript(program: ServiceProgram, home: string, name: string) {
	let argument = serviceArguments(program).map(windowsArgument).join(" ");
	return [
		"$ErrorActionPreference = 'Stop'",
		"$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
		`$action = New-ScheduledTaskAction -Execute ${powershellString(program.executable)}`
		+ ` -Argument ${powershellString(argument)} -WorkingDirectory ${powershellString(home)}`,
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

function windowsPowershell(env: Env) {
	let root =
		[env.SystemRoot, env.SYSTEMROOT, env.windir].find(value =>
			!!value && /^[A-Za-z]:\\[^%"]*$/.test(value) && !hasControl(value)
		) ?? "C:\\Windows";
	return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function powershell(host: ServiceHost, script: string) {
	return host.run(windowsPowershell(host.env), [
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

/** The interpreter a script names through `#!/usr/bin/env`, which must resolve too. */
async function interpreter(file: string) {
	let head = await Bun.file(file).slice(0, 256).text().catch(() => "");
	return head.match(/^#!\s*\S*\/env\s+(?:-S\s+)?([^\s-][^\s]*)/)?.[1];
}

/**
 * The PATH the service runs with, once the agent, the interpreter its script names and git all
 * resolve under it; otherwise a refusal, before anything is written.
 */
async function agentPath(host: ServiceHost, command: string[]) {
	let which = host.which ?? ((name, PATH) => Bun.which(name, { PATH }));
	let path = paths(host.platform);
	let agent = command[0]!;
	let found = which(agent, pathVariable(host));
	if (!found) {
		throw new ServiceError(
			`The agent command ${agent} is not on your PATH. Nothing was installed. `
				+ "Pass the agent's absolute path after --.",
		);
	}
	let directory = path.dirname(found);
	// A per-shell directory is often a link into a version manager's stable one.
	if (host.platform !== "win32") directory = await realpath(directory).catch(() => directory);
	let service = servicePath(host.platform, host.env, directory);
	let runtime = host.platform === "win32" ? undefined : await interpreter(found);
	for (let needed of [agent, ...(runtime ? [runtime] : []), "git"]) {
		if (which(needed, service)) continue;
		let what = needed === agent
			? `the agent command ${agent}`
			: needed === "git"
			? "git"
			: `${needed}, which ${agent} runs with,`;
		throw new ServiceError(
			[
				`The service would not find ${what} under the PATH it runs with:`,
				`  ${service}`,
				"Nothing was installed. That PATH leaves out directories that last only as long as "
				+ "this login or shell. Install it outside them, or pass the agent's absolute path "
				+ "after --.",
			].join("\n"),
		);
	}
	return service;
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
 * Install `program` as this user's service and start it, so it starts again by itself. The
 * server and the program go to config.json first, where the service's connect reads the server.
 * A service an older chopin than one already installed is refused without `allowDowngrade`.
 */
export async function installService(
	host: ServiceHost,
	program: ServiceProgram,
	options: { server: string; allowDowngrade?: boolean; version?: string },
): Promise<Installed> {
	let manager = serviceManager(host.platform);
	let version = options.version ?? VERSION;
	let unusable = unsupportedPath(host.platform, program);
	if (unusable) throw new ServiceError(unusable);
	let path = await agentPath(host, program.command);
	if (
		manager === "launchd"
		&& [path, ...program.command].some(hasControl)
	) {
		throw new ServiceError(
			"The agent command or PATH holds a control character, which a LaunchAgent cannot hold. "
				+ "Nothing was installed.",
		);
	}
	let previous = (await readConfig(program.directory)).service?.version;
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
			value.server = options.server;
			value.service = { ...program, version, installedAt: Date.now() };
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
		let before = await taskState(host);
		await record();
		if (before?.state === "Running") {
			await stopTask(host, program.directory);
		}
		let registered = await powershell(
			host,
			scheduledTaskScript(program, host.home, taskName(host.user)),
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
	let held = (await connectors(directory)).find(item => item.service && item.running);
	if (!held) return "not-running";
	let sleep = host.sleep ?? Bun.sleep;
	await writeFile(stopFile(directory), `${held.pid}\n`, { mode: 0o600 });
	try {
		for (let waited = 0; waited < STOP_SECONDS; waited++) {
			if (!(await connectors(directory)).some(item => item.pid === held.pid && item.running)) {
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
	let connector = (await connectors(directory)).find(item => item.service && item.running);
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
