import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, findAgent } from "@chopin/protocol/agents";
import {
	agentCommand,
	connectArguments,
	pairCommand,
	quote,
	runsAsService,
	setupCommand,
} from "./setup-commands";

const KEY = `chopin_k_${"Ab3-_".repeat(9).slice(0, 43)}`;
const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";

test("one command installs chopin, then connects with the key by chopin's installed path", () => {
	expect(setupCommand("https://chopin.example", "sh", findAgent("copilot"), KEY)).toBe(
		[
			"installer=$(mktemp) \\",
			`  && curl -fsSL ${RELEASES}/install.sh -o "$installer" \\`,
			'  && sh "$installer" && rm -f "$installer" \\',
			"  && CHOPIN_URL=https://chopin.example \\",
			`  CHOPIN_PAIRING_KEY=${KEY} \\`,
			"  ~/.local/bin/chopin connect . \\",
			"  --install-service \\",
			"  -- copilot --acp --allow-all",
		].join("\n"),
	);
});

test("PowerShell connects only once install.ps1 succeeded, with the key in that command's environment", () => {
	let command = setupCommand("https://chopin.example", "powershell", findAgent("copilot"), KEY);
	expect(command).toBe(
		[
			`irm ${RELEASES}/install.ps1 | iex`,
			"if ($LASTEXITCODE -eq 0) {",
			`  $token = '${KEY}'`,
			'  $env:CHOPIN_URL = "https://chopin.example"',
			"  $env:CHOPIN_PAIRING_KEY = $token",
			"  try {",
			'    & "$env:LOCALAPPDATA\\chopin\\bin\\chopin.exe" connect . `',
			"      --install-service `",
			"      -- copilot --acp --allow-all",
			"  } finally { Remove-Item Env:CHOPIN_PAIRING_KEY; Remove-Variable token }",
			"}",
		].join("\n"),
	);
	// Never on chopin's command line, where other programs on the machine can read it.
	expect(command).not.toContain("--key");
});

test("the agent's --env goes on its own line, and an agent that asks permission runs in the terminal", () => {
	expect(
		setupCommand("https://chopin.example", "sh", findAgent("atomic"), KEY).split("\n").slice(-3),
	)
		.toEqual(["  --install-service \\", "  --env ATOMIC_ACP_HEADLESS=1 \\", "  -- atomic-acp"]);
	let claude = findAgent("claude-code");
	expect(runsAsService(claude)).toBe(false);
	expect(setupCommand("https://chopin.example", "sh", claude, KEY).split("\n").slice(-2))
		.toEqual(["  ~/.local/bin/chopin connect . \\", "  -- claude-agent-acp"]);
	expect(
		setupCommand("https://chopin.example", "powershell", claude, KEY).split("\n").slice(-4, -2),
	)
		.toEqual([
			'    & "$env:LOCALAPPDATA\\chopin\\bin\\chopin.exe" connect . `',
			"      -- claude-agent-acp",
		]);
});

/** A curl stand-in's first lines: write to the file `-o` names, else to standard output. */
const CURL_OUTPUT =
	'out=/dev/stdout\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n';

test.skipIf(process.platform === "win32")(
	"the one sh command stops with the installer's own message, never running chopin, when installing fails",
	async () => {
		let home = await mkdtemp(join(tmpdir(), "chopin-setup-command-"));
		try {
			let shims = join(home, "shims");
			await mkdir(shims);
			let failures = {
				// curl -f: GitHub answered with an error, so there is no installer to run.
				download: "echo 'curl: (22) The requested URL returned error: 404' >&2\nexit 22\n",
				// The installer ran and refused, as install.sh does when it can't fetch chopin.
				installer:
					`${CURL_OUTPUT}printf '%s\\n' "echo 'chopin install: could not download chopin' >&2" 'exit 1' > "$out"\n`,
			};
			for (let [name, body] of Object.entries(failures)) {
				await writeFile(join(shims, "curl"), `#!/bin/sh\n${body}`);
				await chmod(join(shims, "curl"), 0o755);
				for (let shell of ["sh", "bash", "zsh"]) {
					let found = Bun.which(shell);
					if (!found) continue;
					let command = setupCommand("https://chopin.example", "sh", findAgent("copilot"), KEY);
					let run = Bun.spawnSync([found, "-c", command], {
						env: { HOME: home, PATH: `${shims}:/usr/bin:/bin` },
						stderr: "pipe",
					});
					let said = run.stderr.toString();
					expect(run.exitCode, `${shell} ${name}: ${said}`).not.toBe(0);
					expect(said).toContain(
						name === "download" ? "returned error: 404" : "chopin install: could not download",
					);
					expect(said).not.toContain("not found");
					expect(said).not.toContain("No such file");
				}
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"sh, bash and zsh each run the one command as one: install, then chopin with the key",
	async () => {
		let home = await mkdtemp(join(tmpdir(), "chopin-setup-command-"));
		try {
			let shims = join(home, "shims");
			await mkdir(shims);
			// curl hands sh an installer that puts a chopin in ~/.local/bin, as install.sh does.
			let chopin =
				`#!/bin/sh\nprintf '%s\\n' "$CHOPIN_URL" "$CHOPIN_PAIRING_KEY" "$@" > "$HOME/ran"\n`;
			await writeFile(
				join(shims, "curl"),
				`#!/bin/sh\n${CURL_OUTPUT}cat > "$out" <<'EOF'\nmkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/chopin" <<'END'\n${chopin}END\nchmod 755 "$HOME/.local/bin/chopin"\nEOF\n`,
			);
			await chmod(join(shims, "curl"), 0o755);
			for (let shell of ["sh", "bash", "zsh"]) {
				let found = Bun.which(shell);
				if (!found) continue;
				for (let agent of AGENTS) {
					await rm(join(home, ".local"), { recursive: true, force: true });
					let command = setupCommand("https://chopin.example", "sh", agent, KEY);
					let run = Bun.spawnSync([found, "-c", command], {
						env: { HOME: home, PATH: `${shims}:/usr/bin:/bin` },
						stderr: "pipe",
					});
					expect(run.stderr.toString(), `${shell} ${agent.id}`).toBe("");
					expect(run.exitCode).toBe(0);
					expect((await readFile(join(home, "ran"), "utf8")).split("\n").slice(0, -1)).toEqual([
						"https://chopin.example",
						KEY,
						"connect",
						".",
						...runsAsService(agent) ? ["--install-service"] : [],
						...agent.env.flatMap(variable => ["--env", variable]),
						"--",
						...agent.acp,
					]);
				}
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);

const PWSH = Bun.which("pwsh");

/**
 * The PowerShell setup command pasted into pwsh, with `installer` (a PowerShell script) standing in
 * for install.ps1 and a chopin.exe that records its environment and arguments.
 */
async function pasted(installer: string, env: Record<string, string> = {}) {
	let home = await mkdtemp(join(tmpdir(), "chopin-setup-powershell-"));
	try {
		let script = join(home, "install.ps1");
		await writeFile(script, installer);
		let command = setupCommand("https://chopin.example", "powershell", findAgent("copilot"), KEY)
			.replace(`irm ${RELEASES}/install.ps1`, `Get-Content -Raw '${script}'`);
		let run = Bun.spawnSync([
			PWSH!,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`${command}\n"after: [$env:CHOPIN_PAIRING_KEY] [$token]"`,
		], { env: { ...process.env, LOCALAPPDATA: home, ...env }, stdout: "pipe", stderr: "pipe" });
		let ran = await readFile(join(home, "ran"), "utf8").catch(() => undefined);
		return { output: run.stdout.toString() + run.stderr.toString(), ran };
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test.skipIf(!PWSH || process.platform === "win32")(
	"pasted into PowerShell, the command runs chopin only after install.ps1 succeeded, and clears the key",
	async () => {
		// Installs a chopin.exe (a sh script here) as install.ps1 does.
		let fake = join(await mkdtemp(join(tmpdir(), "chopin-setup-fake-")), "chopin.exe");
		await writeFile(
			fake,
			`#!/bin/sh\nprintf '%s\\n' "$CHOPIN_URL" "$CHOPIN_PAIRING_KEY" "$@" > "$LOCALAPPDATA/ran"\n`,
		);
		await chmod(fake, 0o755);
		let installs = [
			'$bin = Join-Path $env:LOCALAPPDATA "chopin/bin"',
			"New-Item -ItemType Directory -Force $bin | Out-Null",
			`Copy-Item '${fake}' (Join-Path $bin "chopin.exe")`,
			"$global:LASTEXITCODE = 0",
		].join("\n");
		let installed = await pasted(installs);
		expect(installed.ran?.split("\n").slice(0, -1), installed.output).toEqual([
			"https://chopin.example",
			KEY,
			"connect",
			".",
			"--install-service",
			"--",
			"copilot",
			"--acp",
			"--allow-all",
		]);
		expect(installed.output).toContain("after: [] []");

		// The real install.ps1 refusing (here, a version that isn't one) stops it before chopin.
		let install = await readFile(
			join(import.meta.dir, "../../../connector/install/install.ps1"),
			"utf8",
		);
		let refused = await pasted(install, { CHOPIN_VERSION: "0.2.0\nevil" });
		expect(refused.output).toContain("chopin install:");
		expect(refused.ran).toBeUndefined();
		expect(refused.output).not.toContain("chopin.exe");
		expect(refused.output).toContain("after: [] []");
	},
	60_000,
);

test("every agent that can run unattended connects as the service, in either shell", () => {
	for (let agent of AGENTS) {
		expect(runsAsService(agent)).toBe(agent.unattended === true);
		for (let shell of ["sh", "powershell"] as const) {
			expect(connectArguments(agent, shell).includes("--install-service"))
				.toBe(runsAsService(agent));
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
