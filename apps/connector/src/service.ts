import { posix, win32 } from "node:path";

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
