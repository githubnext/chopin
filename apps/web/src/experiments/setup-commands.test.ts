import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, findAgent } from "@chopin/protocol/agents";
import {
	agentCommand,
	connectArguments,
	guessSystem,
	pairCommand,
	quote,
	runsAsService,
	setupCommand,
} from "./setup-commands";

const KEY = `chopin_k_${"Ab3-_".repeat(9).slice(0, 43)}`;
const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";
const ORIGIN = "https://chopin.example";

test("one sh command: the installer runs chopin connect itself, with a key only for a server", () => {
	let copilot = findAgent("copilot");
	expect(setupCommand(ORIGIN, "sh", copilot)).toBe(
		[
			`curl -fsSL ${RELEASES}/install.sh | \\`,
			"  CHOPIN_URL=https://chopin.example sh -s -- connect --install-service -- copilot --acp --allow-all",
		].join("\n"),
	);
	expect(setupCommand(ORIGIN, "sh", copilot, { key: KEY })).toBe(
		[
			`curl -fsSL ${RELEASES}/install.sh | \\`,
			`  CHOPIN_URL=https://chopin.example CHOPIN_PAIRING_KEY=${KEY} sh -s -- connect --install-service -- copilot --acp --allow-all`,
		].join("\n"),
	);
	// Run in the terminal instead, and the agent's own variables.
	expect(setupCommand(ORIGIN, "sh", copilot, { background: false }).split("\n")[1])
		.toBe("  CHOPIN_URL=https://chopin.example sh -s -- connect -- copilot --acp --allow-all");
	expect(setupCommand(ORIGIN, "sh", findAgent("atomic")).split("\n")[1]).toEndWith(
		"sh -s -- connect --install-service --env ATOMIC_ACP_HEADLESS=1 -- atomic-acp",
	);
	expect(setupCommand(ORIGIN, "sh", findAgent("claude-code")).split("\n")[1])
		.toEndWith("sh -s -- connect -- claude-agent-acp");
});

test("one PowerShell command: the key in the session only, on a line PSReadLine keeps out of its history file", () => {
	let copilot = findAgent("copilot");
	let installer =
		`& ([scriptblock]::Create((irm ${RELEASES}/install.ps1))) connect --install-service '--' copilot --acp --allow-all`;
	expect(setupCommand(ORIGIN, "powershell", copilot)).toBe(
		["$env:CHOPIN_URL = 'https://chopin.example'", installer].join("\n"),
	);
	let keyed = setupCommand(ORIGIN, "powershell", copilot, { key: KEY });
	expect(keyed).toBe(
		[
			`$env:CHOPIN_URL = 'https://chopin.example'; $env:CHOPIN_PAIRING_KEY = ($token = '${KEY}'); Remove-Variable token`,
			installer,
		].join("\n"),
	);
	// Never on chopin's command line, where other programs on the machine can read it.
	expect(keyed).not.toContain("--key");
	expect(setupCommand(ORIGIN, "powershell", findAgent("claude-code")).split("\n")[1])
		.toEndWith("connect '--' claude-agent-acp");
});

test("the system is guessed from the browser", () => {
	expect(guessSystem("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
	expect(guessSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
	expect(guessSystem("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
	expect(guessSystem("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("linux");
});

/**
 * A curl that hands sh an installer standing in for install.sh: it records the environment and
 * arguments it was given, as the chopin it would run.
 */
const RECORDING_INSTALLER =
	`printf '%s\\n' "$CHOPIN_URL" "$CHOPIN_PAIRING_KEY" "$@" > "$HOME/ran"\n`;

async function pastedIntoSh(curl: string, run: (shims: string, home: string) => Promise<void>) {
	let home = await mkdtemp(join(tmpdir(), "chopin-setup-command-"));
	try {
		let shims = join(home, "shims");
		await mkdir(shims);
		await writeFile(join(shims, "curl"), `#!/bin/sh\n${curl}`);
		await chmod(join(shims, "curl"), 0o755);
		await run(shims, home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test.skipIf(process.platform === "win32")(
	"sh, bash and zsh hand the installer every argument and the key exactly",
	async () => {
		await pastedIntoSh(`cat <<'EOF'\n${RECORDING_INSTALLER}EOF\n`, async (shims, home) => {
			for (let shell of ["sh", "bash", "zsh"]) {
				let found = Bun.which(shell);
				if (!found) continue;
				for (let agent of AGENTS) {
					for (let key of [undefined, KEY]) {
						await rm(join(home, "ran"), { force: true });
						let command = setupCommand(ORIGIN, "sh", agent, { key });
						let run = Bun.spawnSync([found, "-c", command], {
							env: { HOME: home, PATH: `${shims}:/usr/bin:/bin` },
							stderr: "pipe",
						});
						expect(run.stderr.toString(), `${shell} ${agent.id}`).toBe("");
						expect(run.exitCode).toBe(0);
						expect((await readFile(join(home, "ran"), "utf8")).split("\n").slice(0, -1)).toEqual([
							ORIGIN,
							key ?? "",
							"connect",
							...runsAsService(agent) ? ["--install-service"] : [],
							...agent.env.flatMap(variable => ["--env", variable]),
							"--",
							...agent.acp,
						]);
					}
				}
			}
		});
	},
);

// curl -f writes nothing on an HTTP error, so sh reads no script and runs nothing.
test.skipIf(process.platform === "win32")(
	"when the installer can't be downloaded, curl says why and nothing runs",
	async () => {
		await pastedIntoSh(
			"echo 'curl: (22) The requested URL returned error: 404' >&2\nexit 22\n",
			async (shims, home) => {
				for (let shell of ["sh", "bash", "zsh"]) {
					let found = Bun.which(shell);
					if (!found) continue;
					let run = Bun.spawnSync(
						[found, "-c", setupCommand(ORIGIN, "sh", findAgent("copilot"), { key: KEY })],
						{ env: { HOME: home, PATH: `${shims}:/usr/bin:/bin` }, stderr: "pipe" },
					);
					expect(run.stderr.toString(), shell).toBe(
						"curl: (22) The requested URL returned error: 404\n",
					);
					expect(await Bun.file(join(home, "ran")).exists()).toBe(false);
				}
			},
		);
	},
);

const PWSH = Bun.which("pwsh");

/**
 * The PowerShell setup command pasted into pwsh, line by line as PSReadLine runs a paste, with
 * `installer` (a PowerShell script) standing in for install.ps1.
 */
async function pasted(installer: string, key?: string) {
	let home = await mkdtemp(join(tmpdir(), "chopin-setup-powershell-"));
	try {
		let script = join(home, "install.ps1");
		await writeFile(script, installer);
		let command = setupCommand(ORIGIN, "powershell", findAgent("atomic"), { key })
			.replace(`irm ${RELEASES}/install.ps1`, `Get-Content -Raw '${script}'`);
		let run = Bun.spawnSync([
			PWSH!,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`${command}\n"after: [$env:CHOPIN_PAIRING_KEY] [$token]"`,
		], { env: { ...process.env, LOCALAPPDATA: home }, stdout: "pipe", stderr: "pipe" });
		let ran = await readFile(join(home, "ran"), "utf8").catch(() => undefined);
		return { output: run.stdout.toString() + run.stderr.toString(), ran };
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test.skipIf(!PWSH)(
	"pasted into PowerShell, install.ps1 gets every argument, -- included, and the key, which goes",
	async () => {
		let recording = [
			'$lines = @("$env:CHOPIN_URL", "$env:CHOPIN_PAIRING_KEY") + $args',
			'Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "ran") -Value $lines',
			"Remove-Item Env:CHOPIN_PAIRING_KEY -ErrorAction SilentlyContinue",
		].join("\n");
		for (let key of [undefined, KEY]) {
			let result = await pasted(recording, key);
			expect(result.ran?.split(/\r?\n/).slice(0, -1), result.output).toEqual([
				ORIGIN,
				key ?? "",
				"connect",
				"--install-service",
				"--env",
				"ATOMIC_ACP_HEADLESS=1",
				"--",
				"atomic-acp",
			]);
			expect(result.output).toContain("after: [] []");
		}

		// The real install.ps1 refusing (here, as it isn't Windows) runs no chopin, and the key goes.
		let install = await readFile(
			join(import.meta.dir, "../../../connector/install/install.ps1"),
			"utf8",
		);
		let refused = await pasted(install, KEY);
		expect(refused.output).toContain("chopin install:");
		expect(refused.ran).toBeUndefined();
		expect(refused.output).toContain("after: [] []");
	},
	60_000,
);

// PSReadLine 2.0.4 and later leave a line out of the history file when it assigns a literal to a
// variable named like a token; Windows PowerShell 5.1's PSReadLine 2.0.0 saves every line.
test.skipIf(!PWSH)(
	"PSReadLine keeps the line with the key out of its history file, and only that line",
	() => {
		let lines = setupCommand(ORIGIN, "powershell", findAgent("copilot"), { key: KEY }).split("\n");
		let check = Bun.spawnSync([
			PWSH!,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			[
				"Import-Module PSReadLine",
				...lines.map(line =>
					`[Microsoft.PowerShell.PSConsoleReadLine]::GetDefaultAddToHistoryOption('${
						line.replaceAll("'", "''")
					}').ToString()`
				),
			].join("\n"),
		], { stdout: "pipe", stderr: "pipe" });
		expect(check.stdout.toString().trim().split(/\r?\n/), check.stderr.toString())
			.toEqual(["MemoryOnly", "MemoryAndFile"]);
	},
	30_000,
);

test("every agent that can run unattended connects as the service, in either shell", () => {
	for (let agent of AGENTS) {
		expect(runsAsService(agent)).toBe(agent.unattended === true);
		for (let shell of ["sh", "powershell"] as const) {
			expect(connectArguments(agent, shell).includes("--install-service"))
				.toBe(runsAsService(agent));
			expect(connectArguments(agent, shell, false).includes("--install-service")).toBe(false);
		}
	}
	expect(AGENTS.filter(runsAsService).map(agent => agent.id))
		.toEqual(["copilot", "atomic", "codex", "gemini"]);
});

test("installing an agent and signing in is one copyable block, @-scoped packages quoted for PowerShell", () => {
	let atomic = findAgent("atomic");
	expect(agentCommand(atomic, "sh")).toBe(
		[
			"npm install -g @bastani/atomic @bastani/atomic-acp",
			"atomic # sign in with /login, then quit",
		].join("\n"),
	);
	expect(agentCommand(atomic, "powershell")).toBe(
		[
			"npm install -g '@bastani/atomic' '@bastani/atomic-acp'",
			"atomic # sign in with /login, then quit",
		].join("\n"),
	);
	expect(agentCommand(findAgent("copilot"), "sh")).toBe(
		["npm install -g @github/copilot", "copilot login"].join("\n"),
	);
});

test("a word goes bare only where the shell reads it as itself", () => {
	expect(quote("--acp", "sh")).toBe("--acp");
	expect(quote("KEY=1", "powershell")).toBe("KEY=1");
	expect(quote("@scope/pkg", "sh")).toBe("@scope/pkg");
	expect(quote("@scope/pkg", "powershell")).toBe("'@scope/pkg'");
	expect(quote("a,b", "powershell")).toBe("'a,b'");
	expect(quote("it's $HOME", "sh")).toBe("'it'\\''s $HOME'");
	expect(quote("it's $HOME", "powershell")).toBe("'it''s $HOME'");
	expect(quote("", "sh")).toBe("''");
});

test("bash reads back every word of every agent's commands exactly as the list has it", () => {
	for (let agent of AGENTS) {
		let commands = [...agent.install, agent.signIn.command, [...agent.env, ...agent.acp]];
		for (let words of commands) {
			let line = words.map(word => quote(word, "sh")).join(" ");
			let read = Bun.spawnSync(["bash", "-c", `printf '%s\\n' ${line}`]).stdout.toString();
			expect(read).toBe(words.map(word => `${word}\n`).join(""));
		}
	}
});

test("pairing again keeps the machine's name, quoted only when the shell needs it", () => {
	expect(pairCommand("build-box.local")).toBe("chopin pair --label build-box.local");
	expect(pairCommand("Mia’s MacBook")).toBe('chopin pair --label "Mia’s MacBook"');
	// A name either shell would expand inside quotes falls back to the hostname default.
	expect(pairCommand('say "$HOME"')).toBe("chopin pair");
	expect(pairCommand("")).toBe("chopin pair");
});
