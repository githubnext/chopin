import { expect, test } from "bun:test";
import {
	launchdPlist,
	parsePlistRun,
	parseTaskRun,
	parseUnitRun,
	scheduledTaskScript,
	servicePath,
	systemdQuote,
	systemdUnit,
	taskAction,
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

test("a service with Planner backends passes each document and the Planner command to connect", () => {
	let program = {
		...PROGRAM,
		planners: ["https://chopin.example/d/one", "https://chopin.example/d/two?x=$y&z=100%"],
		plannerCommand: `planner --label="two words" 'it''s' $HOME`,
	};
	let words = [
		"connect",
		program.checkout,
		"--base-dir",
		program.directory,
		"--service",
		"--planner",
		program.planners[0]!,
		"--planner",
		program.planners[1]!,
		"--planner-command",
		program.plannerCommand,
		"--",
		...program.command,
	];
	let unit = systemdUnit(program, "/usr/bin");
	expect(unit).toContain(
		'"--service" "--planner" "https://chopin.example/d/one" "--planner" '
			+ '"https://chopin.example/d/two?x=$$y&z=100%%" "--planner-command" '
			+ '"planner --label=\\"two words\\" \'it\'\'s\' $$HOME" "--" "copilot"',
	);
	let plist = launchdPlist(program, "/home/ada", "/usr/bin");
	expect([...plist.matchAll(/\t\t<string>(.*)<\/string>/g)].map(match => match[1])).toEqual(
		[program.executable, ...words].map(word =>
			word.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
		).concat("/usr/bin"),
	);
	let windows = {
		...program,
		executable: "C:\\chopin\\chopin.exe",
		checkout: "C:\\src\\score",
		command: ["C:\\Tools\\agent.exe"],
		directory: "C:\\state",
		planners: ["https://chopin.example/d/one?a=1&b=2"],
		plannerCommand: 'planner --label="two words" ^x',
	};
	let action = taskAction(windows, "C:\\Tools", "C:\\Windows\\System32\\cmd.exe");
	expect(argv(cmdParse(action.argument).line.split(/ && (?=")/)[1]!)).toEqual([
		windows.executable,
		"connect",
		windows.checkout,
		"--base-dir",
		windows.directory,
		"--service",
		"--planner",
		windows.planners[0]!,
		"--planner-command",
		windows.plannerCommand,
		"--",
		...windows.command,
	]);
	// The service still reads its chopin and base dir back, and holds no credential.
	let run = { executable: program.executable, directory: program.directory };
	expect(parseUnitRun(unit)).toEqual(run);
	expect(parsePlistRun(plist)).toEqual(run);
	for (let definition of [unit, plist, action.argument]) {
		expect(definition).not.toMatch(/chopin_m_|TOKEN/);
	}
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

/** What cmd /s /c runs: the text between the outer quotes, its carets outside quotes removed. */
function cmdParse(argument: string) {
	let inner = argument.match(/^\/d \/v:off \/s \/c "(.*)"$/)?.[1];
	if (inner === undefined) throw new Error(`not a cmd /s /c line: ${argument}`);
	let quoted = false;
	let out = "";
	let unquoted = "";
	for (let index = 0; index < inner.length; index++) {
		let character = inner[index]!;
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === "^") character = inner[++index]!;
		else if (!quoted) unquoted += character;
		out += character;
	}
	return { line: out, unquoted };
}

/** How a program's C runtime splits its command line into arguments. */
function argv(line: string) {
	let words: string[] = [];
	let word: string | undefined;
	let quoted = false;
	for (let index = 0; index < line.length;) {
		let character = line[index]!;
		if (!quoted && /\s/.test(character)) {
			if (word !== undefined) words.push(word);
			word = undefined;
			index++;
			continue;
		}
		word ??= "";
		let slashes = 0;
		while (line[index] === "\\") {
			slashes++;
			index++;
		}
		if (line[index] === '"') {
			word += "\\".repeat(Math.floor(slashes / 2));
			if (slashes % 2) word += '"';
			else quoted = !quoted;
			index++;
		} else {
			word += "\\".repeat(slashes);
			if (index < line.length && !slashes) word += line[index++];
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

test("the scheduled task runs chopin through cmd with the service PATH set", () => {
	let program = {
		executable: "C:\\Users\\O'Neil\\AppData\\Local\\chopin\\bin\\chopin.exe",
		checkout: "C:\\Users\\O'Neil\\R&D (old)\\score^1",
		command: ["C:\\Tools\\copilot.exe", "--acp", '--note=say "hi" & <bye>|^', "a\\"],
		directory: "C:\\Users\\O'Neil\\.chopin\\",
	};
	let path = "C:\\Tools;C:\\Program Files (x86)\\R&D\\bin";
	let action = taskAction(program, path, "C:\\Windows\\System32\\cmd.exe");
	expect(action.execute).toBe("C:\\Windows\\System32\\cmd.exe");
	let { line, unquoted } = cmdParse(action.argument);
	// cmd sees only `set`, the one `&&` and spaces outside quotes; everything else reaches chopin.
	expect(unquoted.replaceAll(/[^&|<>()]/g, "")).toBe("&&");
	let [set, run] = line.split(/ && (?=")/);
	expect(set).toBe(`set "PATH=${path}"`);
	expect(argv(run!)).toEqual([
		program.executable,
		"connect",
		program.checkout,
		"--base-dir",
		program.directory,
		"--service",
		"--",
		...program.command,
	]);

	let script = scheduledTaskScript(action, "C:\\Users\\O'Neil", "chopin-O~0027Neil");
	let parts = script.split("; ");
	expect(parts).toContain("$ErrorActionPreference = 'Stop'");
	let made = parts.find(part => part.startsWith("$action = "))!;
	expect(made).toStartWith(
		"$action = New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\cmd.exe' -Argument (",
	);
	expect(made).toEndWith(" -WorkingDirectory 'C:\\Users\\O''Neil'");
	// PowerShell rebuilds the argument exactly: '' is one quote and [char]34 a double quote.
	let expression = made.slice(made.indexOf("-Argument (") + 11, made.lastIndexOf(") -Working"));
	expect(
		expression.split(" + [char]34 + ").map(piece => piece.slice(1, -1).replaceAll("''", "'"))
			.join('"'),
	).toBe(action.argument);
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
	// The task sets it inside cmd's quotes: a quoted entry loses its quotes, and one with a % or
	// a control character, which cmd would expand or break on, is left out.
	expect(
		servicePath(
			"win32",
			{ Path: '"C:\\Program Files\\Tool";%USERPROFILE%\\bin;C:\\a\nb;C:\\Git\\cmd' },
			"C:\\Tools",
		),
	).toBe("C:\\Tools;C:\\Program Files\\Tool;C:\\Git\\cmd");
});

test("each definition gives back the chopin and base dir it was written with", () => {
	let posix = {
		...PROGRAM,
		executable: "/home/ada/bin $HOME 100%/chopin",
		directory: '/home/ada/st "a" 100% $HOME\\x\t&<>',
	};
	let run = { executable: posix.executable, directory: posix.directory };
	expect(parseUnitRun(systemdUnit(posix, "/usr/bin"))).toEqual(run);
	expect(parsePlistRun(launchdPlist(posix, "/home/ada", "/usr/bin"))).toEqual(run);
	let windows = {
		executable: "C:\\Program Files (x86)\\chopin\\chopin.exe",
		checkout: "C:\\src\\R&D (old)",
		command: ["C:\\Tools\\agent.exe", 'say "hi" & ^bye'],
		directory: "C:\\Users\\Ada\\R&D ^x\\state\\",
	};
	let action = taskAction(windows, "C:\\Tools", "C:\\Windows\\System32\\cmd.exe");
	expect(parseTaskRun(action.execute, action.argument)).toEqual({
		executable: windows.executable,
		directory: windows.directory,
	});
	// A task that runs chopin directly, without cmd setting PATH.
	expect(
		parseTaskRun(
			"C:\\chopin\\chopin.exe",
			'connect "C:\\a b" --base-dir "C:\\st ate\\\\" --service -- agent',
		),
	).toEqual({ executable: "C:\\chopin\\chopin.exe", directory: "C:\\st ate\\" });
	expect(parseUnitRun("[Service]\nExecStart=/bin/true\n")).toBeUndefined();
});
