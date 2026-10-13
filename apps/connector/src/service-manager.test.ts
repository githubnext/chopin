import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, updateConfig } from "./config";
import {
	installService,
	launchdPlist,
	type Outcome,
	restartService,
	scheduledTaskScript,
	type ServiceHost,
	serviceStatus,
	stopFile,
	systemdUnit,
	uninstallService,
} from "./service";

/**
 * Installing, inspecting and removing the service with a scripted service manager: every
 * systemctl, loginctl, launchctl and PowerShell call goes to a runner that records it.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-service-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const SERVER = "https://chopin.example";

/** A home with an agent on PATH, and a host whose runner answers from `answer`, else succeeds. */
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
	let program = {
		executable: "/opt/chopin/bin/chopin",
		checkout: join(home, "checkout"),
		command: ["agent", "--acp"],
		directory,
	};
	return { home, directory, bin, calls, host, program };
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
	let { home, directory, bin, calls, host, program } = await machine("linux", systemd);
	let installed = await installService(host, program, { server: SERVER, version: "0.0.2" });
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
	expect(unit).toBe(systemdUnit(program, `${await realpath(bin)}:/usr/bin:/bin`));
	expect(await readConfig(directory)).toEqual({
		server: SERVER,
		service: { ...program, version: "0.0.2", installedAt: expect.any(Number) },
	});
});

test("on Linux, install stops with the one sudo command when linger needs an administrator", async () => {
	let { home, directory, calls, host, program } = await machine(
		"linux",
		line =>
			line.includes("enable-linger")
				? { code: 1, stderr: "Could not enable linger: Access denied" }
				: systemd(line),
	);
	let error = await installService(host, program, { server: SERVER }).catch(error => error);
	expect(error).toBeInstanceOf(Error);
	expect(error.message).toContain("Access denied");
	expect(error.message).toContain("Nothing was installed.");
	expect(error.message).toContain('\n  sudo loginctl enable-linger "$(id -un)"\n');
	expect(existsSync(unitPath(home))).toBe(false);
	expect(await readConfig(directory)).toEqual({});
	expect(calls.some(line => line.includes("enable --now"))).toBe(false);
});

test("the service PATH skips a shell's fnm directory, and an agent it can't find is refused", async () => {
	let { home, bin, host, program } = await machine("linux", systemd);
	// fnm links each shell's node directory into $XDG_RUNTIME_DIR, which a reboot empties.
	let stable = join(home, "fnm", "node-versions", "v22", "installation", "bin");
	let shell = join(home, "run", "fnm_multishells", "4242_1700000000000");
	await mkdir(stable, { recursive: true });
	await mkdir(join(home, "run", "fnm_multishells"), { recursive: true });
	await symlink(join(stable, ".."), shell);
	await writeFile(join(stable, "copilot"), "#!/usr/bin/env node\n", { mode: 0o755 });
	await writeFile(join(stable, "node"), "#!/bin/sh\n", { mode: 0o755 });
	host.env = { XDG_RUNTIME_DIR: join(home, "run"), PATH: `${join(shell, "bin")}:${bin}:/usr/bin` };
	await installService(host, { ...program, command: ["copilot", "--acp"] }, { server: SERVER });
	let unit = await readFile(unitPath(home), "utf8");
	expect(unit).toContain(`Environment="PATH=${await realpath(stable)}:${bin}:/usr/bin"`);
	expect(unit).not.toContain("fnm_multishells");

	// An agent whose interpreter only resolves in this shell would fail after a reboot.
	await writeFile(join(bin, "runtime-agent"), "#!/usr/bin/env missing-runtime\n", {
		mode: 0o755,
	});
	let refused = await machine("linux", systemd);
	for (let command of [["runtime-agent"], ["no-such-agent"]]) {
		refused.host.env = { PATH: `${bin}:/usr/bin` };
		let error = await installService(refused.host, { ...refused.program, command }, {
			server: SERVER,
		}).catch(error => error);
		expect(error.message).toContain("Nothing was installed.");
		expect(error.message).toContain(
			command[0] === "no-such-agent" ? "no-such-agent" : "missing-runtime",
		);
		expect(existsSync(unitPath(refused.home))).toBe(false);
		expect(refused.calls).toEqual([]);
	}
});

test("on macOS, install writes the LaunchAgent and bootstraps it into the login session", async () => {
	let { home, bin, calls, host, program } = await machine(
		"darwin",
		line =>
			line.startsWith("launchctl print")
				? { code: 113, stderr: "Could not find service" }
				: undefined,
	);
	let installed = await installService(host, program, { server: SERVER });
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

/** A Windows host whose PowerShell answers task queries with `task`, and which finds any agent. */
async function windows(task: () => string) {
	let setup = await machine(
		"win32",
		line => line.includes("Get-ScheduledTaskInfo") ? { stdout: `${task()}\r\n` } : undefined,
	);
	setup.host.env = { Path: "C:\\Tools;C:\\Git\\cmd", SystemRoot: "C:\\Windows" };
	setup.host.which = (name, path) =>
		path.split(";").includes("C:\\Tools") ? `C:\\Tools\\${name}.exe` : null;
	return setup;
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe "
	+ "-NoProfile -NonInteractive -Command ";

test("on Windows, install registers this account's task at logon and says it needs a logon", async () => {
	let { calls, host, program } = await windows(() => "not-installed");
	let installed = await installService(host, program, { server: SERVER });
	expect(installed.definition).toBe("\\chopin-ada");
	expect(installed.notes.join(" ")).toContain("only while you are logged on");
	expect(calls).toHaveLength(2);
	expect(calls[0]).toStartWith(`${POWERSHELL}$task = Get-ScheduledTask -TaskName 'chopin-ada'`);
	expect(calls[1]).toBe(POWERSHELL + scheduledTaskScript(program, host.home, "chopin-ada"));
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
			root: linux.program.checkout,
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
	let { home, directory, calls, host, program } = await machine("linux", systemd);
	await installService(host, program, { server: SERVER });
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
	expect((await readConfig(directory)).service).toMatchObject({ checkout: program.checkout });
	expect((await uninstallService(host, directory)).removed).toBe(false);
});

test("restart asks each manager to restart, and refuses when nothing is installed", async () => {
	let linux = await machine("linux", systemd);
	await expect(restartService(linux.host, linux.directory)).rejects.toThrow("not installed");
	await installService(linux.host, linux.program, { server: SERVER });
	linux.calls.length = 0;
	await restartService(linux.host, linux.directory);
	expect(linux.calls).toEqual(["systemctl --user restart chopin.service"]);

	let mac = await machine("darwin");
	await installService(mac.host, mac.program, { server: SERVER });
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
	let { home, directory, host, program } = await machine("linux", systemd);
	await installService(host, program, { server: SERVER, version: "0.0.3" });
	let error = await installService(host, { ...program, command: ["agent"] }, {
		server: SERVER,
		version: "0.0.2",
	}).catch(error => error);
	expect(error.message).toContain("set up by chopin 0.0.3, which is newer than this chopin 0.0.2");
	expect(error.message).toContain("--allow-downgrade");
	expect((await readConfig(directory)).service).toMatchObject({ version: "0.0.3" });
	expect(await readFile(unitPath(home), "utf8")).toContain('"--acp"');
	await installService(host, { ...program, command: ["agent"] }, {
		server: SERVER,
		version: "0.0.2",
		allowDowngrade: true,
	});
	expect((await readConfig(directory)).service).toMatchObject({ version: "0.0.2" });
	expect(await readFile(unitPath(home), "utf8")).not.toContain('"--acp"');
});
