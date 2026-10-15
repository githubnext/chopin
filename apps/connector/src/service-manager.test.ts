import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { type ConnectSettings, readConfig, updateConfig } from "./config";
import {
	installService,
	launchdPlist,
	onStopRequest,
	type Outcome,
	restartAfterUpdate,
	restartService,
	scheduledTaskScript,
	type ServiceHost,
	serviceStatus,
	startEnvironment,
	stopFile,
	systemdUnit,
	taskAction,
	uninstallService,
} from "./service";

/**
 * Installing, inspecting and removing the service with a scripted service manager: every
 * systemctl, loginctl, launchctl and PowerShell call goes to a runner that records it.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-service-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const SERVER = "https://chopin.example";

/** Saves what `chopin connect` ran, as it does once it has connected. */
function connected(directory: string, settings: ConnectSettings) {
	return updateConfig(directory, value => {
		value.connect = settings;
	});
}

/**
 * A home with an agent on PATH, where `chopin connect` ran the agent once, and a host whose
 * runner answers from `answer`, else succeeds.
 */
async function machine(
	platform: NodeJS.Platform = "linux",
	answer: (line: string) => Partial<Outcome> | undefined = () => undefined,
) {
	let home = await mkdtemp(join(scratch, "home-"));
	let directory = join(home, "state");
	let bin = join(home, "agent-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "agent"), "#!/bin/sh\n", { mode: 0o755 });
	let calls: string[] = [];
	let host: ServiceHost = {
		platform,
		home,
		user: "ada",
		uid: 501,
		env: { PATH: `${bin}:/usr/bin:/bin` },
		async run(command, args) {
			let line = [command, ...args].join(" ");
			calls.push(line);
			return { code: 0, stdout: "", stderr: "", ...answer(line) };
		},
		sleep: async () => {},
	};
	let program = { executable: "/opt/chopin/bin/chopin", directory };
	let settings: ConnectSettings = {
		server: SERVER,
		checkout: join(home, "checkout"),
		command: [join(bin, "agent"), "--acp"],
		planners: [],
		plannerCommand: [],
	};
	await connected(directory, settings);
	return { home, directory, bin, calls, host, program, settings };
}

function unitPath(home: string) {
	return join(home, ".config", "systemd", "user", "chopin.service");
}

/** systemd answers for a user without linger whose unit is not running yet. */
function systemd(line: string): Partial<Outcome> | undefined {
	if (line.startsWith("loginctl show-user")) return { stdout: "no\n" };
	if (line.startsWith("systemctl --user is-active")) return { code: 3, stdout: "inactive\n" };
	return undefined;
}

test("on Linux, install enables linger, writes the unit and enables it", async () => {
	let { home, directory, bin, calls, host, program, settings } = await machine("linux", systemd);
	let installed = await installService(host, program, { version: "0.0.2" });
	expect(calls).toEqual([
		"systemctl --user show --property=Version",
		"loginctl show-user ada --property=Linger --value",
		"loginctl --no-ask-password enable-linger ada",
		"systemctl --user is-active chopin.service",
		"systemctl --user daemon-reload",
		"systemctl --user enable --now chopin.service",
	]);
	expect(installed).toMatchObject({ manager: "systemd", definition: unitPath(home) });
	let unit = await readFile(unitPath(home), "utf8");
	// The unit runs the settings install copied, so it names no checkout, agent or Planner.
	expect(unit).toContain(
		`ExecStart="/opt/chopin/bin/chopin" "connect" "--base-dir" "${directory}" "--service"\n`,
	);
	expect(unit).toBe(systemdUnit(program, `${await realpath(bin)}:/usr/bin:/bin`));
	// Install copies the last connect as the service's own settings, with the agent by the
	// absolute path the service's PATH resolves it to.
	let copied = { ...settings, command: [join(await realpath(bin), "agent"), "--acp"] };
	expect(await readConfig(directory)).toEqual({
		connect: copied,
		service: { ...program, version: "0.0.2", installedAt: expect.any(Number), settings: copied },
	});
});

test("install again replaces the service's settings with the last connect", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	await installService(host, program);
	let other = {
		...settings,
		checkout: join(directory, "other"),
		command: [join(bin, "agent"), "--other"],
		env: { API_MODE: "s3cret-value" },
	};
	await connected(directory, other);
	expect((await readConfig(directory)).service?.settings?.checkout).toBe(settings.checkout);
	await installService(host, program);
	expect((await readConfig(directory)).service?.settings).toMatchObject({
		checkout: other.checkout,
		command: [expect.stringMatching(/agent$/), "--other"],
		env: { API_MODE: "s3cret-value" },
	});
	// The service reads its --env from config.json; its definition never holds it.
	expect(await readFile(unitPath(home), "utf8")).not.toContain("s3cret");
});

test.skipIf(process.platform === "win32")(
	"install starts the agent once with the service's PATH and --env, and refuses one that can't start",
	async () => {
		let { home, directory, bin, calls, host, program, settings } = await machine("linux", systemd);
		let fake = join(import.meta.dir, "testing", "fake-agent.ts");
		let seen = join(home, "seen");
		await writeFile(
			join(bin, "acp-agent"),
			`#!/bin/sh\necho "$SOME_FLAG|$PATH|$XDG_RUNTIME_DIR" > ${seen}\nexec ${process.execPath} ${fake}\n`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(bin, "logged-out"),
			`#!/bin/sh\necho "agent: not logged in (ghp_${"A".repeat(20)})" >&2\nexit 127\n`,
			{ mode: 0o755 },
		);
		host.env = { ...host.env, XDG_RUNTIME_DIR: "/run/user/501" };
		let env = { SOME_FLAG: "from connect" };
		await connected(directory, { ...settings, command: [join(bin, "acp-agent")], env });
		await installService(host, program, { check: true });
		let real = await realpath(bin);
		expect(await readFile(seen, "utf8")).toBe(`from connect|${real}:/usr/bin:/bin|\n`);

		calls.length = 0;
		await rm(unitPath(home));
		await connected(directory, { ...settings, command: [join(bin, "logged-out"), "--acp"], env });
		let error = await installService(host, program, { check: true }).catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("exit 127: agent: not logged in ([redacted])");
		expect(error.message).toContain("Nothing was installed.");
		expect(error.message).toContain("--skip-check");
		expect(calls).toEqual([]);
		expect(existsSync(unitPath(home))).toBe(false);
		// Without the check, as --skip-check asks, it installs.
		await installService(host, program);
		expect(existsSync(unitPath(home))).toBe(true);
	},
	20_000,
);

test.skipIf(process.platform === "win32")(
	"install's start check leaves nothing of the agent's process group running, even a child that ignores SIGTERM",
	async () => {
		let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
		let fake = join(import.meta.dir, "testing", "fake-agent.ts");
		let group = join(home, "group");
		// The agent's shell records its process group, starts a child that ignores SIGTERM, then
		// becomes an agent that answers initialize and exits on SIGTERM.
		await writeFile(
			join(bin, "forking-agent"),
			`#!/bin/sh\necho $$ > ${group}\n(trap '' TERM; while :; do sleep 1; done) &\n`
				+ `exec ${process.execPath} ${fake}\n`,
			{ mode: 0o755 },
		);
		await connected(directory, { ...settings, command: [join(bin, "forking-agent")] });
		let pgid = 0;
		try {
			await installService(host, program, { check: true });
			pgid = Number(await readFile(group, "utf8"));
			let { stdout } = Bun.spawnSync(["ps", "-A", "-o", "pgid=,stat="]);
			let alive = String(stdout).split("\n").map(line => line.trim().split(/\s+/))
				.filter(([id, stat]) => Number(id) === pgid && !stat?.startsWith("Z"));
			expect(alive).toEqual([]);
		} finally {
			pgid ||= Number(await readFile(group, "utf8").catch(() => 0));
			try {
				if (pgid) process.kill(-pgid, "SIGKILL");
			} catch { /* The group is gone. */ }
		}
	},
	20_000,
);

test("the start check gives the agent the service PATH, --env, the home and user name, and on Windows only what starting a process needs besides", async () => {
	let { host } = await machine("linux");
	let env = { API_MODE: "from connect" };
	host.env = {
		PATH: "/usr/bin",
		SHELL_SECRET: "from this shell",
		XDG_RUNTIME_DIR: "/run/user/501",
	};
	expect(startEnvironment(host, env, "/stable/bin:/usr/bin")).toEqual({
		HOME: host.home,
		USER: "ada",
		LOGNAME: "ada",
		PATH: "/stable/bin:/usr/bin",
		API_MODE: "from connect",
	});
	let windows: ServiceHost = {
		...host,
		platform: "win32",
		home: "C:\\Users\\ada",
		env: {
			Path: "C:\\Windows\\System32;C:\\tools",
			SystemRoot: "C:\\Windows",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
			TEMP: "C:\\Users\\ada\\AppData\\Local\\Temp",
			TMP: "C:\\Users\\ada\\AppData\\Local\\Temp",
			USERPROFILE: "C:\\Users\\ada",
			APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
			SHELL_SECRET: "from this shell",
			GITHUB_TOKEN: "from this shell",
		},
	};
	let { SHELL_SECRET: _secret, GITHUB_TOKEN: _token, Path: _path, ...needed } = windows.env;
	expect(startEnvironment(windows, env, "C:\\tools")).toEqual({
		...needed,
		HOME: "C:\\Users\\ada",
		USERNAME: "ada",
		Path: "C:\\tools",
		API_MODE: "from connect",
	});
});

test("install refuses until chopin connect has saved what the service runs", async () => {
	let { home, directory, calls, host, program } = await machine("linux", systemd);
	await updateConfig(directory, value => {
		delete value.connect;
	});
	let error = await installService(host, program).catch(error => error);
	expect(error.message).toBe(
		"Run chopin connect once first, then chopin service install.",
	);
	expect(calls).toEqual([]);
	expect(existsSync(unitPath(home))).toBe(false);
	expect(await readConfig(directory)).toEqual({});
});

test("install runs only the agent and Planner command connect found, refusing a bare name or one gone since", async () => {
	let { home, directory, bin, calls, host, program, settings } = await machine("linux", systemd);
	await writeFile(join(bin, "planner"), "#!/bin/sh\n", { mode: 0o755 });
	let again = "Nothing was installed. Run `chopin connect` again so chopin saves the";
	let planned = {
		planners: ["https://chopin.example/d/one"],
		plannerCommand: [join(bin, "planner")],
	};
	let cases: Array<[Partial<ConnectSettings>, string]> = [
		// The service's PATH finds an agent by this name, but not necessarily the one connect checked.
		[
			{ command: ["agent", "--acp"] },
			`The agent agent was saved without its full path. ${again} agent's full path.`,
		],
		[
			{ command: [join(bin, "gone"), "--acp"] },
			`The agent ${join(bin, "gone")}, which chopin connect found, is no longer there. ${again} `
			+ "agent's full path.",
		],
		[
			{ ...planned, plannerCommand: ["planner"] },
			`The Planner command planner was saved without its full path. ${again} Planner command's `
			+ "full path.",
		],
		[
			{ ...planned, plannerCommand: [join(bin, "gone-planner")] },
			`The Planner command ${join(bin, "gone-planner")}, which chopin connect found, is no longer `
			+ `there. ${again} Planner command's full path.`,
		],
	];
	for (let [change, message] of cases) {
		await connected(directory, { ...settings, ...change });
		let error = await installService(host, program).catch(error => error);
		expect(error.message).toBe(message);
		expect(calls).toEqual([]);
		expect(existsSync(unitPath(home))).toBe(false);
		expect((await readConfig(directory)).service).toBeUndefined();
	}
});

test("on Linux, install stops with the one sudo command when linger needs an administrator", async () => {
	let { home, directory, calls, host, program } = await machine(
		"linux",
		line =>
			line.includes("enable-linger")
				? { code: 1, stderr: "Could not enable linger: Access denied" }
				: systemd(line),
	);
	let error = await installService(host, program).catch(error => error);
	expect(error).toBeInstanceOf(Error);
	expect(error.message).toContain("Access denied");
	expect(error.message).toContain("Nothing was installed.");
	expect(error.message).toContain('\n  sudo loginctl enable-linger "$(id -un)"\n');
	expect(existsSync(unitPath(home))).toBe(false);
	expect((await readConfig(directory)).service).toBeUndefined();
	expect(calls.some(line => line.includes("enable --now"))).toBe(false);
});

test("install checks the saved Planner command under the service PATH; one it can't find is refused", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	await writeFile(join(bin, "planner"), "#!/bin/sh\n", { mode: 0o755 });
	let planned = {
		...settings,
		planners: ["https://chopin.example/d/one", "https://chopin.example/d/two"],
		plannerCommand: [join(bin, "planner"), "--label=two words"],
	};
	await connected(directory, planned);
	await installService(host, program);
	expect(await readFile(unitPath(home), "utf8")).not.toContain("planner");
	expect((await readConfig(directory)).service?.settings).toMatchObject({
		planners: planned.planners,
		plannerCommand: planned.plannerCommand,
	});

	let refused = await machine("linux", systemd);
	refused.host.env = { PATH: `${bin}:/usr/bin` };
	await connected(refused.directory, {
		...planned,
		plannerCommand: [join(bin, "no-such-planner"), "--x"],
	});
	let error = await installService(refused.host, refused.program).catch(error => error);
	expect(error.message).toContain("Nothing was installed.");
	expect(error.message).toContain("no-such-planner");
	expect(existsSync(unitPath(refused.home))).toBe(false);
	expect(refused.calls).toEqual([]);
});

test("the service PATH skips a shell's fnm directory, and an agent it can't find is refused", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	// fnm links each shell's node directory into $XDG_RUNTIME_DIR, which a reboot empties.
	let stable = join(home, "fnm", "node-versions", "v22", "installation", "bin");
	let shell = join(home, "run", "fnm_multishells", "4242_1700000000000");
	await mkdir(stable, { recursive: true });
	await mkdir(join(home, "run", "fnm_multishells"), { recursive: true });
	await symlink(join(stable, ".."), shell);
	await writeFile(join(stable, "copilot"), "#!/usr/bin/env node\n", { mode: 0o755 });
	await writeFile(join(stable, "node"), "#!/bin/sh\n", { mode: 0o755 });
	host.env = { XDG_RUNTIME_DIR: join(home, "run"), PATH: `${join(shell, "bin")}:${bin}:/usr/bin` };
	await connected(directory, { ...settings, command: [join(shell, "bin", "copilot"), "--acp"] });
	await installService(host, program);
	let unit = await readFile(unitPath(home), "utf8");
	expect(unit).toContain(`Environment="PATH=${await realpath(stable)}:${bin}:/usr/bin"`);
	expect(unit).not.toContain("fnm_multishells");

	// An agent whose interpreter only resolves in this shell would fail after a reboot.
	await writeFile(join(bin, "runtime-agent"), "#!/usr/bin/env missing-runtime\n", {
		mode: 0o755,
	});
	let refused = await machine("linux", systemd);
	for (let command of [[join(bin, "runtime-agent")], [join(bin, "no-such-agent")]]) {
		refused.host.env = { PATH: `${bin}:/usr/bin` };
		await connected(refused.directory, { ...refused.settings, command });
		let error = await installService(refused.host, refused.program).catch(error => error);
		expect(error.message).toContain("Nothing was installed.");
		expect(error.message).toContain(
			command[0]!.endsWith("no-such-agent") ? "no-such-agent" : "missing-runtime",
		);
		expect(existsSync(unitPath(refused.home))).toBe(false);
		expect(refused.calls).toEqual([]);
	}
});

test("an agent reached through a runtime directory runs from its stable path after a reboot", async () => {
	let { home, directory, host, program, settings } = await machine("linux", systemd);
	let run = join(home, "run");
	let stable = join(home, "fnm", "node-versions", "v22", "installation");
	let shell = join(run, "fnm_multishells", "4242_1700000000000");
	await mkdir(join(stable, "bin"), { recursive: true });
	await mkdir(join(run, "fnm_multishells"), { recursive: true });
	await symlink(stable, shell);
	await writeFile(join(stable, "bin", "agent"), "#!/bin/sh\n", { mode: 0o755 });
	host.env = { XDG_RUNTIME_DIR: run, PATH: "/usr/bin:/bin" };
	// The agent's absolute path, as this shell sees it, goes through the shell's link.
	await connected(directory, { ...settings, command: [join(shell, "bin", "agent"), "--acp"] });
	await installService(host, program);
	let real = await realpath(join(stable, "bin"));
	let unit = await readFile(unitPath(home), "utf8");
	expect(unit).toBe(systemdUnit(program, `${real}:/usr/bin:/bin`));
	let command = (await readConfig(directory)).service?.settings?.command;
	expect(command).toEqual([join(real, "agent"), "--acp"]);
	// A reboot empties the runtime directory; the agent the service runs is still there.
	await rm(run, { recursive: true });
	expect(existsSync(command![0]!)).toBe(true);
});

test("install checks the program behind env and both scripts' interpreters, and puts node's stable directory on the service PATH", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	// fnm: node lives in a stable versions directory, reached through this shell's own link.
	let run = join(home, "run");
	let installation = join(home, "fnm", "node-versions", "v24", "installation");
	let stable = join(installation, "bin");
	let shell = join(run, "fnm_multishells", "4242_1700000000000");
	await mkdir(stable, { recursive: true });
	await mkdir(join(run, "fnm_multishells"), { recursive: true });
	await symlink(installation, shell);
	await writeFile(join(stable, "node"), "#!/bin/sh\n", { mode: 0o755 });
	for (let name of ["my-agent", "my-planner"]) {
		await writeFile(join(stable, name), "#!/usr/bin/env node\n", { mode: 0o755 });
	}
	let real = await realpath(stable);
	let servicePath = async () =>
		(await readFile(unitPath(home), "utf8")).match(/^Environment="PATH=(.*)"$/m)![1]!;
	let planned = {
		...settings,
		planners: ["https://chopin.example/d/one"],
		plannerCommand: [join(stable, "my-planner"), "planner"],
	};
	host.env = { XDG_RUNTIME_DIR: run, PATH: `${join(shell, "bin")}:${bin}:/usr/bin:/bin` };
	for (
		let [command, saved] of [
			// The agent wrapped in env: install checks the program after the assignments.
			[
				["/usr/bin/env", "SOME_FLAG=1", join(stable, "my-agent"), "--acp"],
				["/usr/bin/env", "SOME_FLAG=1", join(real, "my-agent"), "--acp"],
			],
			[
				["env", "SOME_FLAG=1", join(shell, "bin", "my-agent")],
				["/usr/bin/env", "SOME_FLAG=1", join(real, "my-agent")],
			],
			// A plain agent: only the Planner command needs node.
			[[join(bin, "agent"), "--acp"], [join(await realpath(bin), "agent"), "--acp"]],
		]
	) {
		await connected(directory, { ...planned, command });
		await installService(host, program);
		let path = await servicePath();
		expect(Bun.which("node", { PATH: path })).toBe(join(real, "node"));
		expect(path).not.toContain("fnm_multishells");
		expect((await readConfig(directory)).service?.settings?.command).toEqual(saved);
	}
});

test("install follows a chain of #! interpreters to node and puts its stable directory on the service PATH; a deeper chain or a loop is refused", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	// fnm: node lives only in a stable versions directory, reached through this shell's own link.
	let run = join(home, "run");
	let installation = join(home, "fnm", "node-versions", "v24", "installation");
	let stable = join(installation, "bin");
	let shell = join(run, "fnm_multishells", "4242_1700000000000");
	await mkdir(stable, { recursive: true });
	await mkdir(join(run, "fnm_multishells"), { recursive: true });
	await symlink(installation, shell);
	await writeFile(join(stable, "node"), "#!/bin/sh\n", { mode: 0o755 });
	// The agent runs with wrapper-a, which runs with wrapper-b, which runs with node.
	await writeFile(join(bin, "chain-agent"), "#!/usr/bin/env wrapper-a\n", { mode: 0o755 });
	await writeFile(join(bin, "wrapper-a"), "#!/usr/bin/env wrapper-b\n", { mode: 0o755 });
	await writeFile(join(bin, "wrapper-b"), "#!/usr/bin/env node\n", { mode: 0o755 });
	host.env = { XDG_RUNTIME_DIR: run, PATH: `${join(shell, "bin")}:${bin}:/usr/bin:/bin` };
	await connected(directory, { ...settings, command: [join(bin, "chain-agent"), "--acp"] });
	await installService(host, program);
	let path = (await readFile(unitPath(home), "utf8")).match(/^Environment="PATH=(.*)"$/m)![1]!;
	expect(Bun.which("node", { PATH: path })).toBe(join(await realpath(stable), "node"));
	expect(path).not.toContain("fnm_multishells");

	// Six interpreters deep, or a loop, never ends in a program the service can run.
	let real = await realpath(bin);
	for (let level = 1; level <= 6; level++) {
		await writeFile(join(bin, `deep-${level}`), `#!/usr/bin/env deep-${level + 1}\n`, {
			mode: 0o755,
		});
	}
	await writeFile(join(bin, "deep-7"), "#!/bin/sh\n", { mode: 0o755 });
	await writeFile(join(bin, "deep-agent"), "#!/usr/bin/env deep-1\n", { mode: 0o755 });
	await writeFile(join(bin, "loop-a"), "#!/usr/bin/env loop-b\n", { mode: 0o755 });
	await writeFile(join(bin, "loop-b"), "#!/usr/bin/env loop-a\n", { mode: 0o755 });
	await writeFile(join(bin, "loop-agent"), "#!/usr/bin/env loop-a\n", { mode: 0o755 });
	await rm(unitPath(home));
	let cases = [
		["deep-agent", "more than 5 #! interpreters"],
		["loop-agent", "#! interpreters loop"],
	];
	for (let [agent, why] of cases) {
		await connected(directory, { ...settings, command: [join(bin, agent!)] });
		let error = await installService(host, program).catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain(join(real, agent!));
		expect(error.message).toContain(why!);
		expect(error.message).toContain("Nothing was installed.");
		expect(existsSync(unitPath(home))).toBe(false);
	}
});

test("an interpreter found only in a per-shell directory, or not at all, is refused by name", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	let run = join(home, "run");
	let shell = join(run, "fnm_multishells", "4242_1700000000000", "bin");
	await mkdir(shell, { recursive: true });
	await writeFile(join(shell, "node"), "#!/bin/sh\n", { mode: 0o755 });
	await writeFile(join(bin, "my-planner"), "#!/usr/bin/env node\n", { mode: 0o755 });
	await writeFile(join(bin, "odd-planner"), "#!/opt/no-such/interp\n", { mode: 0o755 });
	host.env = { XDG_RUNTIME_DIR: run, PATH: `${shell}:${bin}:/usr/bin:/bin` };
	let cases = [
		["my-planner", join(shell, "node"), "link it into a directory on the service's PATH"],
		["odd-planner", "/opt/no-such/interp", "/opt/no-such/interp"],
	];
	for (let [planner, named, fix] of cases) {
		await connected(directory, {
			...settings,
			planners: ["https://chopin.example/d/one"],
			plannerCommand: [join(bin, planner!)],
		});
		let error = await installService(host, program).catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain(named!);
		expect(error.message).toContain(fix!);
		expect(error.message).toContain("Nothing was installed.");
		expect(existsSync(unitPath(home))).toBe(false);
	}
});

test("a #! line with Windows line endings, or one that names no absolute path or /usr/bin/env, is refused for the agent and the Planner command", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	await writeFile(join(bin, "node"), "#!/bin/sh\n", { mode: 0o755 });
	let real = await realpath(bin);
	let scripts = {
		crlf: "#!/usr/bin/env node\r\nconsole.log('started')\r\n",
		bare: "#!node\nconsole.log('started')\n",
		relative: "#!./bin/python\nprint('started')\n",
		options: "#!/usr/bin/env -i node\n",
	};
	for (let [name, text] of Object.entries(scripts)) {
		await writeFile(join(bin, name), text, { mode: 0o755 });
	}
	let crlf = "has Windows line endings in its first line; convert it with dos2unix";
	let form = "'s #! line must name an absolute path or use /usr/bin/env";
	for (
		let [script, why] of [["crlf", crlf], ["bare", form], ["relative", form], ["options", form]]
	) {
		for (let as of ["agent", "planner"]) {
			await connected(directory, {
				...settings,
				...(as === "agent"
					? { command: [join(bin, script!), "--acp"] }
					: { planners: ["https://chopin.example/d/one"], plannerCommand: [join(bin, script!)] }),
			});
			let error = await installService(host, program).catch(error => error);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain(`${join(real, script!)}${why === form ? "" : " "}${why}`);
			expect(error.message).toContain("Nothing was installed.");
			expect(existsSync(unitPath(home))).toBe(false);
		}
	}
});

test("an agent, interpreter or git that lives under a runtime directory is refused", async () => {
	let { home, directory, bin, host, program, settings } = await machine("linux", systemd);
	let run = join(home, "run");
	let ephemeral = join(run, "tools");
	await mkdir(ephemeral, { recursive: true });
	for (let name of ["agent-real", "node-real", "git-real"]) {
		await writeFile(join(ephemeral, name), "#!/bin/sh\n", { mode: 0o755 });
	}
	// Stable-looking names that only link into the runtime directory.
	await symlink(join(ephemeral, "agent-real"), join(bin, "linked-agent"));
	await writeFile(join(bin, "node-agent"), "#!/usr/bin/env linked-node\n", { mode: 0o755 });
	await symlink(join(ephemeral, "node-real"), join(bin, "linked-node"));
	let git = join(home, "git-bin");
	await mkdir(git);
	await symlink(join(ephemeral, "git-real"), join(git, "git"));
	let cases = [
		{ command: [join(bin, "linked-agent")], path: `${bin}:/usr/bin`, named: "agent-real" },
		{ command: [join(bin, "node-agent")], path: `${bin}:/usr/bin`, named: "node-real" },
		{ command: [join(bin, "agent")], path: `${bin}:${git}:/usr/bin`, named: "git-real" },
	];
	for (let { command, path, named } of cases) {
		host.env = { XDG_RUNTIME_DIR: run, PATH: path };
		await connected(directory, { ...settings, command });
		let error = await installService(host, program)
			.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain(join(await realpath(ephemeral), named));
		expect(error.message).toContain("Nothing was installed.");
		expect(error.message).toContain("somewhere stable");
		expect(existsSync(unitPath(home))).toBe(false);
	}
});

test("an agent that links through a runtime directory's link to a stable one is refused", async () => {
	let { home, directory, calls, host, program, settings } = await machine("linux", systemd);
	let run = join(home, "run");
	let payload = join(home, "stable", "payload");
	let bin = join(home, "stable", "bin");
	await mkdir(payload, { recursive: true });
	await mkdir(bin, { recursive: true });
	await mkdir(run);
	await writeFile(join(payload, "agent"), "#!/bin/sh\n", { mode: 0o755 });
	// The agent ends up stable, but only through a link that lives in the runtime directory.
	// Both links are relative, so each resolves against its own directory.
	await symlink(join("..", "stable", "payload"), join(run, "alias"));
	await symlink(join("..", "..", "run", "alias", "agent"), join(bin, "agent"));
	host.env = { XDG_RUNTIME_DIR: run, PATH: `${bin}:/usr/bin` };
	await connected(directory, { ...settings, command: [join(bin, "agent")] });
	let error = await installService(host, program).catch(error => error);
	expect(error).toBeInstanceOf(Error);
	expect(error.message).toContain(join(run, "alias"));
	expect(error.message).toContain("Nothing was installed.");
	expect(existsSync(unitPath(home))).toBe(false);
	expect(calls).toEqual([]);
	// A reboot empties the runtime directory, and with it the only way to the agent.
	await rm(run, { recursive: true });
	expect(existsSync(join(bin, "agent"))).toBe(false);
});

test("a version manager's shim is installed by its own name, so it still dispatches on it", async () => {
	let { home, directory, host, program, settings } = await machine("linux", systemd);
	let mise = join(home, "mise");
	await mkdir(join(mise, "shims"), { recursive: true });
	await mkdir(join(mise, "bin"));
	await writeFile(join(mise, "bin", "mise"), "#!/bin/sh\n", { mode: 0o755 });
	await symlink(join("..", "bin", "mise"), join(mise, "shims", "agent"));
	await symlink(join(mise, "shims"), join(home, "shims"));
	host.env = { PATH: `${join(home, "shims")}:/usr/bin:/bin` };
	await connected(directory, { ...settings, command: [join(home, "shims", "agent"), "--acp"] });
	await installService(host, program);
	let shim = join(await realpath(join(mise, "shims")), "agent");
	expect((await readConfig(directory)).service?.settings?.command).toEqual([shim, "--acp"]);
});

test("on macOS, install writes the LaunchAgent and bootstraps it into the login session", async () => {
	let { home, bin, calls, host, program } = await machine(
		"darwin",
		line =>
			line.startsWith("launchctl print")
				? { code: 113, stderr: "Could not find service" }
				: undefined,
	);
	let installed = await installService(host, program);
	let plist = join(home, "Library", "LaunchAgents", "com.github.chopin.plist");
	expect(installed.definition).toBe(plist);
	expect(await readFile(plist, "utf8")).toBe(
		launchdPlist(program, home, `${await realpath(bin)}:/usr/bin:/bin`),
	);
	expect(calls).toEqual([
		"launchctl print gui/501/com.github.chopin",
		"launchctl enable gui/501/com.github.chopin",
		`launchctl bootstrap gui/501 ${plist}`,
	]);
});

/** Finds a program by its full path, or by name in C:\\Tools when the PATH holds it. */
function windowsWhich(name: string, path: string) {
	if (win32.isAbsolute(name)) return name;
	return path.split(";").includes("C:\\Tools") ? `C:\\Tools\\${name}.exe` : null;
}

/** A Windows host whose PowerShell answers task queries with `task`, and which finds any agent. */
async function windows(task: () => string) {
	let setup = await machine(
		"win32",
		line => line.includes("Get-ScheduledTaskInfo") ? { stdout: `${task()}\r\n` } : undefined,
	);
	setup.host.env = { Path: "C:\\Tools;C:\\Git\\cmd", SystemRoot: "C:\\Windows" };
	setup.host.which = windowsWhich;
	setup.settings = { ...setup.settings, command: ["C:\\Tools\\agent.exe", "--acp"] };
	await connected(setup.directory, setup.settings);
	return setup;
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe "
	+ "-NoProfile -NonInteractive -Command ";

test("on Windows, install runs the .cmd shim connect found by its full path, never one by name", async () => {
	let { directory, calls, host, program, settings } = await windows(() => "not-installed");
	let shim = "C:\\Users\\ada\\AppData\\Roaming\\npm\\atomic-acp.cmd";
	await connected(directory, { ...settings, command: [shim] });
	await installService(host, program);
	expect((await readConfig(directory)).service?.settings?.command).toEqual([shim]);
	expect(calls.at(-1)).toContain(
		"'PATH=C:\\Users\\ada\\AppData\\Roaming\\npm;C:\\Tools;C:\\Git\\cmd'",
	);
	// C:\Tools has an atomic-acp too, which a bare name would find instead.
	await connected(directory, { ...settings, command: ["atomic-acp"] });
	await expect(installService(host, program)).rejects.toThrow(
		"The agent atomic-acp was saved without its full path.",
	);
});

test("on Windows, install registers this account's task at logon and says it needs a logon", async () => {
	let { calls, host, program } = await windows(() => "not-installed");
	let installed = await installService(host, program);
	expect(installed.definition).toBe("\\chopin-ada");
	expect(installed.notes.join(" ")).toContain("only while you are logged on");
	expect(calls).toHaveLength(2);
	expect(calls[0]).toStartWith(`${POWERSHELL}$task = Get-ScheduledTask -TaskName 'chopin-ada'`);
	// The task runs chopin with the PATH install checked the agent and git under.
	let action = taskAction(program, "C:\\Tools;C:\\Git\\cmd", "C:\\Windows\\System32\\cmd.exe");
	expect(action.argument).toContain('set "PATH=C:\\Tools;C:\\Git\\cmd" && ');
	expect(calls[1]).toBe(POWERSHELL + scheduledTaskScript(action, host.home, "chopin-ada"));
});

test("service status reads each manager's answer, and a connector older than the binary is restart-pending", async () => {
	let linux = await machine("linux", line => {
		if (line.startsWith("systemctl --user show chopin.service")) {
			return {
				stdout: "MainPID=4242\nLoadState=loaded\nActiveState=active\nSubState=running\n"
					+ "UnitFileState=enabled\n",
			};
		}
		if (line.startsWith("loginctl show-user")) return { stdout: "yes\n" };
		if (line === "/opt/chopin/bin/chopin --version") {
			return { stdout: "chopin 0.0.3 (connector protocol 2)\n" };
		}
		return undefined;
	});
	expect(await serviceStatus(linux.host, linux.directory)).toEqual({
		state: "not-installed",
		manager: "systemd",
		definition: unitPath(linux.home),
		log: join(linux.directory, "chopin.log"),
		notes: [],
	});
	await mkdir(join(linux.home, ".config", "systemd", "user"), { recursive: true });
	await writeFile(unitPath(linux.home), "[Unit]\n");
	expect(await serviceStatus(linux.host, linux.directory)).toMatchObject({
		state: "running",
		pid: 4242,
		notes: [],
	});
	// After `chopin update`, the service's connector still runs the version it started with.
	await updateConfig(linux.directory, value => {
		value.service = { ...linux.program, version: "0.0.2", installedAt: 1 };
	});
	let lock = join(linux.directory, `${"c".repeat(64)}.lock`);
	await writeFile(
		lock,
		JSON.stringify({
			pid: process.pid,
			root: linux.settings.checkout,
			version: "0.0.2",
			service: true,
		}),
	);
	let pending = await serviceStatus(linux.host, linux.directory);
	expect(pending).toMatchObject({ state: "restart-pending", running: "0.0.2", installed: "0.0.3" });
	expect(pending.notes.join(" ")).toContain("chopin service restart");

	let mac = await machine("darwin", line =>
		line.startsWith("launchctl print")
			? {
				stdout: "gui/501/com.github.chopin = {\n\tstate = not running\n\tlast exit code = 1\n}\n",
			}
			: undefined);
	await mkdir(join(mac.home, "Library", "LaunchAgents"), { recursive: true });
	await writeFile(join(mac.home, "Library", "LaunchAgents", "com.github.chopin.plist"), "<plist/>");
	let stopped = await serviceStatus(mac.host, mac.directory);
	expect(stopped.state).toBe("stopped");
	expect(stopped.notes.join(" ")).toContain("last exited with 1");

	let task = await windows(() => JSON.stringify({ state: "Ready", lastResult: 2147942402 }));
	let ready = await serviceStatus(task.host, task.directory);
	expect(ready).toMatchObject({
		state: "stopped",
		manager: "task-scheduler",
		definition: "\\chopin-ada",
	});
	expect(ready.notes.join(" ")).toContain("last ended with result 2147942402");
	expect(ready.notes.join(" ")).toContain("only while you are logged on");
	let running = await windows(() => JSON.stringify({ state: "Running", lastResult: 267009 }));
	expect((await serviceStatus(running.host, running.directory)).state).toBe("running");
	let missing = await windows(() => "not-installed");
	expect((await serviceStatus(missing.host, missing.directory)).state).toBe("not-installed");
});

test("uninstall stops and removes the service and leaves the pairing, config and runs", async () => {
	let { home, directory, calls, host, program, settings } = await machine("linux", systemd);
	await installService(host, program);
	let machineFile = join(directory, "machine.json");
	await writeFile(machineFile, '{"servers":{}}\n');
	await mkdir(join(directory, "runs", "run-1"), { recursive: true });
	calls.length = 0;
	let removed = await uninstallService(host, directory);
	expect(removed.removed).toBe(true);
	expect(calls).toEqual([
		"systemctl --user disable --now chopin.service",
		"systemctl --user daemon-reload",
	]);
	expect(existsSync(unitPath(home))).toBe(false);
	expect(existsSync(machineFile)).toBe(true);
	expect(existsSync(join(directory, "runs", "run-1"))).toBe(true);
	expect((await readConfig(directory)).connect).toMatchObject({ checkout: settings.checkout });
	expect((await uninstallService(host, directory)).removed).toBe(false);
});

test("restart asks each manager to restart, and refuses when nothing is installed", async () => {
	let linux = await machine("linux", systemd);
	await expect(restartService(linux.host, linux.directory)).rejects.toThrow("not installed");
	await installService(linux.host, linux.program);
	linux.calls.length = 0;
	await restartService(linux.host, linux.directory);
	expect(linux.calls).toEqual(["systemctl --user restart chopin.service"]);

	let mac = await machine("darwin");
	await installService(mac.host, mac.program);
	mac.calls.length = 0;
	await restartService(mac.host, mac.directory);
	expect(mac.calls).toEqual([
		"launchctl print gui/501/com.github.chopin",
		"launchctl bootout gui/501/com.github.chopin",
		`launchctl bootstrap gui/501 ${
			join(mac.home, "Library", "LaunchAgents", "com.github.chopin.plist")
		}`,
	]);
});

test("on Windows, restart asks the service's connector to stop before Task Scheduler ends it", async () => {
	let { directory, calls, host } = await windows(() => JSON.stringify({ state: "Running" }));
	await mkdir(directory, { recursive: true });
	// The service's connector: a live process that exits once it sees the stop request.
	let child = Bun.spawn(["sleep", "30"]);
	let lock = join(directory, `${"d".repeat(64)}.lock`);
	await writeFile(lock, JSON.stringify({ pid: child.pid, root: "C:\\score", service: true }));
	let requested: string[] = [];
	host.sleep = async () => {
		if (existsSync(stopFile(directory))) {
			requested.push(await readFile(stopFile(directory), "utf8"));
			child.kill();
			await child.exited;
			await rm(lock);
		}
	};
	try {
		await restartService(host, directory);
	} finally {
		child.kill();
	}
	expect(requested).toEqual([`${child.pid}\n`]);
	expect(existsSync(stopFile(directory))).toBe(false);
	expect(calls.at(-2)).toContain("Stop-ScheduledTask -TaskName 'chopin-ada'");
	expect(calls.at(-1)).toBe(
		`${POWERSHELL}Start-ScheduledTask -TaskName 'chopin-ada' -TaskPath '\\'`,
	);
});

test("install refuses to replace a service a newer chopin installed, unless allowed", async () => {
	let { directory, host, program } = await machine("linux", systemd);
	await installService(host, program, { version: "0.0.3" });
	let error = await installService(host, program, { version: "0.0.2" }).catch(error => error);
	expect(error.message).toContain("set up by chopin 0.0.3, which is newer than this chopin 0.0.2");
	expect(error.message).toContain("--allow-downgrade");
	expect((await readConfig(directory)).service).toMatchObject({ version: "0.0.3" });
	await installService(host, program, { version: "0.0.2", allowDowngrade: true });
	expect((await readConfig(directory)).service).toMatchObject({ version: "0.0.2" });
});

test("after an update, a running service on the updated chopin restarts, and nothing else does", async () => {
	let active = "active";
	let failRestart = false;
	let { directory, calls, host, program } = await machine("linux", line => {
		if (line.startsWith("systemctl --user show chopin.service")) {
			return { stdout: `ActiveState=${active}\nUnitFileState=enabled\n` };
		}
		if (line === "systemctl --user restart chopin.service" && failRestart) {
			return { code: 1, stderr: "Failed to restart chopin.service" };
		}
		return systemd(line);
	});
	expect(await restartAfterUpdate(host, directory, program.executable)).toBeUndefined();
	await installService(host, program);
	calls.length = 0;
	expect(await restartAfterUpdate(host, directory, "/elsewhere/chopin")).toContain(
		"runs a different chopin",
	);
	expect(calls).toEqual([]);
	expect(await restartAfterUpdate(host, directory, program.executable)).toBe(
		"Restarted the chopin service, so it runs the new chopin.",
	);
	expect(calls).toContain("systemctl --user restart chopin.service");
	// A stopped service stays stopped, and a failed restart doesn't undo the update.
	calls.length = 0;
	active = "inactive";
	expect(await restartAfterUpdate(host, directory, program.executable)).toBeUndefined();
	expect(calls).not.toContain("systemctl --user restart chopin.service");
	active = "active";
	failRestart = true;
	expect(await restartAfterUpdate(host, directory, program.executable)).toContain(
		"Run chopin service restart",
	);
});

test("after an update, only a service whose definition runs this chopin and base dir restarts", async () => {
	for (let platform of ["linux", "darwin", "win32"] as const) {
		let task: { execute: string; arguments: string } | undefined;
		let setup = await machine(platform, line => {
			if (line.startsWith("systemctl --user show chopin.service")) {
				return { stdout: "ActiveState=active\nUnitFileState=enabled\n" };
			}
			if (line.startsWith("launchctl print")) {
				return { stdout: "gui/501/com.github.chopin = {\n\tstate = running\n}\n" };
			}
			if (line.includes("Get-ScheduledTaskInfo")) return { stdout: '{"state":"Running"}' };
			if (line.includes(".Actions")) return { stdout: task ? JSON.stringify(task) : "" };
			return systemd(line);
		});
		let { host, home, calls } = setup;
		let windows = platform === "win32";
		let settings = windows
			? { ...setup.settings, command: ["C:\\Tools\\agent.exe", "--acp"] }
			: setup.settings;
		if (windows) {
			host.env = { Path: "C:\\Tools;C:\\Git\\cmd", SystemRoot: "C:\\Windows" };
			host.which = windowsWhich;
		}
		let a = {
			...setup.program,
			executable: windows ? "C:\\chopin-a\\chopin.exe" : "/opt/chopin-a/chopin",
			directory: join(home, "a"),
		};
		let b = {
			...a,
			executable: windows ? "C:\\chopin-b\\chopin.exe" : "/opt/chopin-b/chopin",
			directory: join(home, "b"),
		};
		// One service per user: installing from B replaces the one installed from A, whose
		// config.json still names A's chopin.
		for (let { directory } of [a, b]) await connected(directory, settings);
		await installService(host, a);
		await installService(host, b);
		if (windows) {
			let action = taskAction(b, "C:\\Tools;C:\\Git\\cmd", "C:\\Windows\\System32\\cmd.exe");
			task = { execute: action.execute, arguments: action.argument };
		}
		expect((await readConfig(a.directory)).service?.executable).toBe(a.executable);
		for (
			let [executable, directory] of [
				[a.executable, a.directory],
				[a.executable, b.directory],
				[b.executable, a.directory],
			] as const
		) {
			calls.length = 0;
			let said = await restartAfterUpdate(host, directory, executable);
			expect(said).toContain("runs a different chopin");
			expect(said).toContain(b.executable);
			expect(calls.join("\n")).not.toMatch(/restart chopin|bootout|Stop-Sch|Start-Sch/);
		}
		calls.length = 0;
		expect(await restartAfterUpdate(host, b.directory, b.executable)).toBe(
			"Restarted the chopin service, so it runs the new chopin.",
		);
		expect(calls.join("\n")).toMatch(/restart chopin|bootout|Start-Sch/);
	}
});

test("a service connector stops when a stop request names its own process", async () => {
	let { directory } = await machine();
	await mkdir(directory, { recursive: true });
	let stopped = 0;
	let watch = onStopRequest(directory, () => stopped++, 10);
	try {
		await writeFile(stopFile(directory), `${process.pid + 1}\n`);
		await Bun.sleep(50);
		expect(stopped).toBe(0);
		await writeFile(stopFile(directory), `${process.pid}\n`);
		await Bun.sleep(50);
		expect(stopped).toBe(1);
	} finally {
		watch();
	}
});
