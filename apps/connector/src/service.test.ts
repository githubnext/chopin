import { expect, test } from "bun:test";
import {
	launchdPlist,
	scheduledTaskScript,
	servicePath,
	systemdQuote,
	systemdUnit,
	unsupportedPath,
	windowsArgument,
} from "./service";

/** A checkout and agent arguments with spaces, quotes, `%` and `$` in them. */
const PROGRAM = {
	executable: "/home/ada/.local/bin/chopin",
	checkout: '/home/ada/My "Projects"/it\'s 100%',
	command: ["copilot", "--acp", "--model=$MODEL", "a b"],
	directory: "/home/ada/.local/state/chopin/connector",
};

test("the systemd unit runs connect with every word quoted and no secret in it", () => {
	let unit = systemdUnit(PROGRAM, "/opt/agent/bin:/usr/bin");
	expect(unit).toBe([
		"[Unit]",
		"Description=Chopin connector: runs the work you start in Chopin on this machine",
		"Documentation=https://github.com/githubnext/chopin/blob/main/docs/local-experiments.md",
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		'ExecStart="/home/ada/.local/bin/chopin" "connect" '
		+ '"/home/ada/My \\"Projects\\"/it\'s 100%%" "--base-dir" '
		+ '"/home/ada/.local/state/chopin/connector" "--service" "--" "copilot" "--acp" '
		+ '"--model=$$MODEL" "a b"',
		"WorkingDirectory=~",
		'Environment="PATH=/opt/agent/bin:/usr/bin"',
		"Restart=always",
		"RestartSec=5",
		"KillMode=mixed",
		"TimeoutStopSec=90",
		"StandardOutput=append:/home/ada/.local/state/chopin/connector/chopin.log",
		"StandardError=append:/home/ada/.local/state/chopin/connector/chopin.log",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n"));
	expect(unit).not.toContain("chopin_m_");
	expect(systemdQuote("tab\there\\", "argument")).toBe('"tab\\x09here\\\\"');
	expect(systemdQuote("/opt/$HOME", "executable")).toBe('"/opt/$HOME"');
});

test("an executable path systemd cannot run is refused with a way around it", () => {
	for (let executable of ["/home/o'neil/bin/chopin", '/opt/"x"/chopin', "/opt/a\\b/chopin"]) {
		let problem = unsupportedPath("linux", { ...PROGRAM, executable });
		expect(problem).toContain(`systemd can't run ${JSON.stringify(executable)}`);
		expect(problem).toContain("install -m 755");
	}
	expect(unsupportedPath("linux", { ...PROGRAM, executable: "chopin" })).toContain("absolute");
	expect(unsupportedPath("linux", { ...PROGRAM, checkout: "/a\nb" })).toContain(
		"control character",
	);
	expect(unsupportedPath("linux", PROGRAM)).toBeUndefined();
});

test("the LaunchAgent escapes each argument for XML and keeps the agent running", () => {
	let plist = launchdPlist({ ...PROGRAM, command: ["agent", "<&'\">"] }, "/home/ada", "/x:/y");
	expect(plist).toBe([
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
		+ '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		"\t<string>com.github.chopin</string>",
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		"\t\t<string>/home/ada/.local/bin/chopin</string>",
		"\t\t<string>connect</string>",
		"\t\t<string>/home/ada/My &quot;Projects&quot;/it&apos;s 100%</string>",
		"\t\t<string>--base-dir</string>",
		"\t\t<string>/home/ada/.local/state/chopin/connector</string>",
		"\t\t<string>--service</string>",
		"\t\t<string>--</string>",
		"\t\t<string>agent</string>",
		"\t\t<string>&lt;&amp;&apos;&quot;&gt;</string>",
		"\t</array>",
		"\t<key>WorkingDirectory</key>",
		"\t<string>/home/ada</string>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>PATH</key>",
		"\t\t<string>/x:/y</string>",
		"\t</dict>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<true/>",
		"\t<key>ThrottleInterval</key>",
		"\t<integer>10</integer>",
		"\t<key>ExitTimeOut</key>",
		"\t<integer>90</integer>",
		"\t<key>ProcessType</key>",
		"\t<string>Interactive</string>",
		"\t<key>StandardOutPath</key>",
		"\t<string>/home/ada/.local/state/chopin/connector/chopin.log</string>",
		"\t<key>StandardErrorPath</key>",
		"\t<string>/home/ada/.local/state/chopin/connector/chopin.log</string>",
		"</dict>",
		"</plist>",
		"",
	].join("\n"));
});

test("Windows arguments are quoted the way a program splits its command line", () => {
	expect(windowsArgument("plain")).toBe("plain");
	expect(windowsArgument("")).toBe('""');
	expect(windowsArgument("C:\\My Projects\\")).toBe('"C:\\My Projects\\\\"');
	expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
	expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
});

test("the scheduled task runs at logon, restarts on failure and quotes for PowerShell", () => {
	let script = scheduledTaskScript(
		{
			executable: "C:\\Users\\O'Neil\\AppData\\Local\\chopin\\bin\\chopin.exe",
			checkout: "C:\\Users\\O'Neil\\My Projects\\score",
			command: ["copilot", "--acp", '--note=say "hi"'],
			directory: "C:\\Users\\O'Neil\\.chopin",
		},
		"C:\\Users\\O'Neil",
		"chopin-O~0027Neil",
	);
	let parts = script.split("; ");
	expect(parts).toContain("$ErrorActionPreference = 'Stop'");
	expect(parts).toContain(
		"$action = New-ScheduledTaskAction"
			+ " -Execute 'C:\\Users\\O''Neil\\AppData\\Local\\chopin\\bin\\chopin.exe'"
			+ " -Argument ('connect ' + [char]34 + 'C:\\Users\\O''Neil\\My Projects\\score' + [char]34"
			+ " + ' --base-dir C:\\Users\\O''Neil\\.chopin --service -- copilot --acp ' + [char]34"
			+ " + '--note=say \\' + [char]34 + 'hi\\' + [char]34 + '' + [char]34 + '')"
			+ " -WorkingDirectory 'C:\\Users\\O''Neil'",
	);
	expect(parts).toContain("$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user");
	expect(parts).toContain(
		"$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
	);
	expect(parts).toContain(
		"$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)"
			+ " -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable"
			+ " -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
	);
	expect(parts.at(-2)).toBe(
		"Register-ScheduledTask -TaskName 'chopin-O~0027Neil' -TaskPath '\\' -Description"
			+ " 'Chopin connector: runs the work you start in Chopin on this machine' -Action $action"
			+ " -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
	);
	expect(parts.at(-1)).toBe("Start-ScheduledTask -TaskName 'chopin-O~0027Neil' -TaskPath '\\'");
	// The script reaches powershell.exe as one command-line argument, so it holds no double quote.
	expect(script).not.toContain('"');
});

test("the service PATH puts the agent's directory first and drops directories a reboot removes", () => {
	let env = {
		XDG_RUNTIME_DIR: "/run/user/1000",
		PATH: [
			"/run/user/1000/fnm_multishells/4242_1700000000000/bin",
			"/home/ada/.local/bin",
			"",
			"/usr/bin",
			"/run/user/1000/other",
			"/tmp/fnm_multishells/9_9/bin",
			"/usr/bin/",
			"/bin",
		].join(":"),
	};
	expect(servicePath("linux", env, "/home/ada/.local/share/fnm/node-versions/v22/installation/bin"))
		.toBe(
			[
				"/home/ada/.local/share/fnm/node-versions/v22/installation/bin",
				"/home/ada/.local/bin",
				"/usr/bin",
				"/bin",
			].join(":"),
		);
	// /run/user/<uid> is dropped even when XDG_RUNTIME_DIR is unset, as under sudo or cron.
	expect(servicePath("linux", { PATH: "/run/user/501/x:/usr/bin" }, "/opt/agent/bin")).toBe(
		"/opt/agent/bin:/usr/bin",
	);
	expect(servicePath("linux", {}, "/opt/agent/bin")).toBe(
		"/opt/agent/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	);
	// Windows compares entries without case or trailing separators and keeps its own `Path`.
	expect(
		servicePath(
			"win32",
			{
				Path:
					"C:\\Tools\\;c:\\tools;C:\\Users\\ada\\AppData\\Local\\fnm_multishells\\1_2;C:\\Git\\cmd",
			},
			"C:\\Tools",
		),
	).toBe("C:\\Tools;C:\\Git\\cmd");
});
