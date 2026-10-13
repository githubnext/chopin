import { afterAll, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assets, fakeChopin, fakeRelease, sha256 } from "../src/testing/release";

/** The release install scripts, run against a local server that serves a fake release. */
let scratch = await mkdtemp(join(tmpdir(), "chopin-install-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

// install.sh is for Linux and macOS; its shims are shell scripts that Windows cannot run.
describe.skipIf(process.platform === "win32")("install.sh", () => {
	let script = join(import.meta.dir, "install.sh");

	/**
	 * A fresh HOME, and shims for uname, gh and sudo that record how they were called. With
	 * `downloader: "wget"`, PATH has only the tools install.sh uses, with wget and without curl.
	 */
	async function machine(
		options: { os?: string; arch?: string; gh?: number; downloader?: "curl" | "wget" } = {},
	) {
		let home = await mkdtemp(join(scratch, "home-"));
		let shims = join(home, "shims");
		await mkdir(shims);
		let log = join(home, "calls.log");
		let shim = async (name: string, body: string) => {
			await writeFile(join(shims, name), `#!/bin/sh\n${body}\n`);
			await chmod(join(shims, name), 0o755);
		};
		await shim(
			"uname",
			`case "$1" in -s) echo ${options.os ?? "Linux"} ;; -m) echo ${
				options.arch ?? "x86_64"
			} ;; *) echo ${options.os ?? "Linux"} ;; esac`,
		);
		await shim("gh", `echo "gh $*" >> "${log}"\nexit ${options.gh ?? 0}`);
		await shim("sudo", `echo "sudo $*" >> "${log}"\nexit 1`);
		let path = `${shims}:${process.env.PATH}`;
		if (options.downloader === "wget") {
			let tools = join(home, "tools");
			await mkdir(tools);
			for (
				let tool of ["sh", "wget", "mktemp", "rm", "tr", "grep", "head", "sed", "awk", "cut"]
					.concat(["sha256sum", "chmod", "mkdir", "cp", "mv", "cat"])
			) {
				let found = Bun.which(tool);
				if (!found) throw new Error(`${tool} is needed to test install.sh with wget.`);
				await symlink(found, join(tools, tool));
			}
			path = `${shims}:${tools}`;
		}
		let calls = async () =>
			(await Bun.file(log).exists()) ? (await readFile(log, "utf8")).trim() : "";
		return { home, shims, path, calls, chopin: join(home, ".local/bin/chopin") };
	}

	async function install(
		at: Awaited<ReturnType<typeof machine>>,
		env: Record<string, string>,
		...args: string[]
	) {
		return run(at, env, ["sh", script, ...args]);
	}

	async function run(
		at: Awaited<ReturnType<typeof machine>>,
		env: Record<string, string>,
		command: string[],
	) {
		// Asynchronous: the fake release is served from this process.
		let child = Bun.spawn(command, {
			env: { HOME: at.home, PATH: at.path, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		let [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	}

	test("installs the newest CLI release into ~/.local/bin after verifying it", async () => {
		using release = fakeRelease({
			"0.1.0": assets("chopin-linux-x64", fakeChopin("0.1.0")),
			"0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")),
		});
		let at = await machine();
		let result = await install(at, release.env);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("0.2.0"));
		expect((await stat(at.chopin)).mode & 0o111).not.toBe(0);
		expect(result.stdout).toContain(
			`Installed chopin 0.2.0 (connector protocol 1) at ${at.chopin}`,
		);
		expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
		// The attestation is checked with gh before the binary is installed; sudo is never asked.
		expect(await at.calls()).toMatch(
			/^gh attestation verify \S+\/chopin-linux-x64 -R githubnext\/chopin$/,
		);
	});

	test("installs the version pinned by argument or CHOPIN_VERSION", async () => {
		using release = fakeRelease({
			"0.1.0": assets("chopin-linux-arm64", fakeChopin("0.1.0")),
			"0.2.0": assets("chopin-linux-arm64", fakeChopin("0.2.0")),
		});
		let at = await machine({ arch: "aarch64" });
		let pinned = await install(at, release.env, "0.1.0");
		expect(pinned.stderr).toBe("");
		expect(pinned.stdout).toContain("Installed chopin 0.1.0 (connector protocol 1)");
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("0.1.0"));

		let environment = await install(at, { ...release.env, CHOPIN_VERSION: "cli-v0.1.0" });
		expect(environment.stdout).toContain("Installed chopin 0.1.0 (connector protocol 1)");
		expect(release.requests).not.toContain("/api/releases");
	});

	test("refuses a binary whose checksum does not match checksums.txt", async () => {
		using release = fakeRelease({
			"0.2.0": assets("chopin-darwin-arm64", fakeChopin("0.2.0"), sha256("something else")),
		});
		let at = await machine({ os: "Darwin", arch: "arm64" });
		let result = await install(at, release.env);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Refusing to install it.");
		expect(await Bun.file(at.chopin).exists()).toBe(false);
		expect(await at.calls()).toBe("");
	});

	test("reads a checksums.txt with Windows line endings", async () => {
		let binary = fakeChopin("0.2.0");
		using release = fakeRelease({
			"0.2.0": {
				"chopin-linux-x64": binary,
				"checksums.txt": `${"0".repeat(64)}  other-file\r\n${sha256(binary)}  chopin-linux-x64\r\n`,
			},
		});
		let at = await machine();
		let result = await install(at, release.env);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(await readFile(at.chopin, "utf8")).toBe(binary);
	});

	test("refuses to install over a directory at ~/.local/bin/chopin", async () => {
		using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
		let at = await machine();
		await mkdir(at.chopin, { recursive: true });
		let result = await install(at, release.env);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(`${at.chopin} is a directory`);
		expect(await readdir(at.chopin)).toEqual([]);
		expect(await readdir(join(at.home, ".local/bin"))).toEqual(["chopin"]);
	});

	test("stages the new chopin in a file of its own beside the old one", async () => {
		using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
		let at = await machine();
		let bin = join(at.home, ".local/bin");
		await mkdir(bin, { recursive: true });
		let victim = join(at.home, "victim");
		await writeFile(victim, "untouched\n");
		// exec keeps the process, so install.sh's $$ is the pid that named this link.
		let result = await run(at, release.env, [
			"sh",
			"-c",
			`ln -s "${victim}" "${bin}/.chopin.$$" && exec sh "$0"`,
			script,
		]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(await readFile(victim, "utf8")).toBe("untouched\n");
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("0.2.0"));
		expect((await stat(at.chopin)).mode & 0o777).toBe(0o755);
		// Only the planted link is left beside chopin; nothing is staged there afterwards.
		expect((await readdir(bin)).filter(name => name !== "chopin")).toHaveLength(1);
	});

	test("downloads only over HTTPS, refusing a redirect to plain HTTP", async () => {
		let binary = fakeChopin("0.2.0");
		using release = fakeRelease({
			"0.2.0": {
				...assets("chopin-linux-x64", binary),
				"chopin-linux-x64": { redirect: "/cli-v0.2.1/chopin-linux-x64" },
			},
			"0.2.1": { "chopin-linux-x64": binary },
		});
		let curl = await machine();
		let refused = await install(curl, release.env, "0.2.0");
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("could not download");
		expect(await Bun.file(curl.chopin).exists()).toBe(false);
		// curl does not even request the plain HTTP URL.
		expect(release.requests).not.toContain("/cli-v0.2.1/chopin-linux-x64");

		// wget cannot refuse to follow it, but what it downloads is not used.
		let wget = await machine({ downloader: "wget" });
		let result = await install(wget, release.env, "0.2.0");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("redirected to a URL that is not HTTPS");
		expect(await Bun.file(wget.chopin).exists()).toBe(false);
	});

	test("refuses a plain HTTP URL for releases unless it is on this machine", async () => {
		let at = await machine();
		for (
			let [env, args] of [
				[{ CHOPIN_RELEASE_BASE_URL: "http://example.invalid/releases" }, ["0.2.0"]],
				[{ CHOPIN_RELEASE_BASE_URL: "http://127.0.0.1@example.invalid/releases" }, ["0.2.0"]],
				[{ CHOPIN_RELEASE_BASE_URL: "ftp://127.0.0.1/releases" }, ["0.2.0"]],
				[{ CHOPIN_RELEASES_API_URL: "http://example.invalid/api/releases" }, []],
			] as [Record<string, string>, string[]][]
		) {
			let result = await install(at, env, ...args);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("must be an https:// URL");
		}

		// The tests' own server is plain HTTP on 127.0.0.1; localhost works too.
		for (let downloader of ["curl", "wget"] as const) {
			using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
			let local = await machine({ downloader });
			let result = await install(local, {
				CHOPIN_RELEASE_BASE_URL: release.env.CHOPIN_RELEASE_BASE_URL.replace(
					"127.0.0.1",
					"localhost",
				),
				CHOPIN_RELEASES_API_URL: release.env.CHOPIN_RELEASES_API_URL,
			});
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
		}
	});

	test("refuses a version with anything but digits, letters, dots, plus and minus", async () => {
		using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
		let at = await machine();
		for (let version of ["0.2.0\nevil", "0.2.0\n", "0.2.0-rc.1/../x", "0.2.0+é"]) {
			let pinned = await install(at, release.env, version);
			expect(pinned.code).not.toBe(0);
			expect(pinned.stderr).toContain("is not a version like 0.2.0");
			let environment = await install(at, { ...release.env, CHOPIN_VERSION: version });
			expect(environment.stderr).toContain("is not a version like 0.2.0");
		}
		expect(release.requests).toEqual([]);
		expect(await Bun.file(at.chopin).exists()).toBe(false);
	});

	test("refuses a binary whose provenance attestation does not verify", async () => {
		using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
		let at = await machine({ gh: 1 });
		let refused = await install(at, release.env);
		expect(refused.code).not.toBe(0);
		expect(refused.stderr).toContain("gh attestation verify could not confirm");
		expect(await Bun.file(at.chopin).exists()).toBe(false);

		let unchecked = await machine({ gh: 1 });
		let result = await install(unchecked, { ...release.env, CHOPIN_VERIFY_ATTESTATION: "0" });
		expect(result.code).toBe(0);
		expect(await unchecked.calls()).toBe("");
	});

	test("refuses an unsupported operating system or architecture", async () => {
		using release = fakeRelease({ "0.2.0": assets("chopin-linux-x64", fakeChopin("0.2.0")) });
		for (
			let [platform, message] of [
				[{ arch: "riscv64" }, "the riscv64 architecture is not supported"],
				[{ os: "FreeBSD" }, "FreeBSD is not supported"],
			] as const
		) {
			let at = await machine(platform);
			let result = await install(at, release.env);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(message);
			expect(await Bun.file(at.chopin).exists()).toBe(false);
		}
		expect(release.requests).toEqual([]);
	});
});

describe("install.ps1", () => {
	let script = join(import.meta.dir, "install.ps1");
	let pwsh = Bun.which("pwsh");
	if (!pwsh) {
		console.warn("Skipping the install.ps1 tests: PowerShell (pwsh) is not installed here.");
	}

	async function install(env: Record<string, string>, ...args: string[]) {
		let child = Bun.spawn([
			pwsh!,
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			script,
			...args,
		], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
		let [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, output: stdout + stderr };
	}

	let readUserPath = () =>
		Bun.spawnSync([
			pwsh!,
			"-NoProfile",
			"-Command",
			"[Environment]::GetEnvironmentVariable('Path', 'User')",
		], { stdout: "pipe" }).stdout.toString().trim();

	test.skipIf(!pwsh)("parses as PowerShell", () => {
		let result = Bun.spawnSync([
			pwsh!,
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.ToString() }`,
		], { stdout: "pipe", stderr: "pipe" });
		expect(result.stdout.toString() + result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test.skipIf(!pwsh || process.platform === "win32")("refuses to run outside Windows", async () => {
		using release = fakeRelease({});
		let result = await install(release.env, "0.2.0");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("install.ps1 installs chopin on Windows");
		expect(release.requests).toEqual([]);
	});

	test.skipIf(!pwsh)(
		"refuses a plain HTTP URL for releases unless it is on this machine",
		async () => {
			for (
				let [env, args] of [
					[{ CHOPIN_RELEASE_BASE_URL: "http://example.invalid/releases" }, ["0.2.0"]],
					[{ CHOPIN_RELEASE_BASE_URL: "http://127.0.0.1@example.invalid/releases" }, ["0.2.0"]],
					[{ CHOPIN_RELEASE_BASE_URL: "ftp://127.0.0.1/releases" }, ["0.2.0"]],
					[{ CHOPIN_RELEASES_API_URL: "http://example.invalid/api/releases" }, []],
				] as [Record<string, string>, string[]][]
			) {
				let result = await install({ ...env, LOCALAPPDATA: scratch }, ...args);
				expect(result.code).not.toBe(0);
				expect(result.output).toContain("must be an https:// URL");
			}
		},
		// Each case starts PowerShell, which is slow to start on Windows.
		60_000,
	);

	test.skipIf(!pwsh)(
		"refuses a version with anything but digits, letters, dots, plus and minus",
		async () => {
			using release = fakeRelease({});
			for (let version of ["0.2.0\n", "0.2.0\nevil", "0.2.0-rc.1/../x", "0.2.0-\u212Aelvin"]) {
				let result = await install({
					...release.env,
					CHOPIN_VERSION: version,
					LOCALAPPDATA: scratch,
				});
				expect(result.code).not.toBe(0);
				expect(result.output).toContain("is not a version like 0.2.0");
			}
			expect(release.requests).toEqual([]);
		},
		60_000,
	);

	test.skipIf(!pwsh || process.platform !== "win32")(
		"refuses a download redirected to plain HTTP",
		async () => {
			let binary = new Uint8Array(await Bun.file(process.execPath).arrayBuffer());
			using release = fakeRelease({
				"0.2.0": {
					...assets("chopin-windows-x64.exe", binary),
					"chopin-windows-x64.exe": { redirect: "/cli-v0.2.1/chopin-windows-x64.exe" },
				},
				"0.2.1": { "chopin-windows-x64.exe": binary },
			});
			let local = await mkdtemp(join(scratch, "localappdata-"));
			let result = await install(
				{ ...release.env, LOCALAPPDATA: local, CHOPIN_VERIFY_ATTESTATION: "0" },
				"0.2.0",
			);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("which is not HTTPS");
			expect(await Bun.file(join(local, "chopin", "bin", "chopin.exe")).exists()).toBe(false);
		},
		120_000,
	);

	// On Windows the fake chopin.exe is Bun itself: a real executable that answers --version.
	test.skipIf(!pwsh || process.platform !== "win32")(
		"installs a verified release into %LOCALAPPDATA%\\chopin\\bin and refuses a mismatch",
		async () => {
			let binary = new Uint8Array(await Bun.file(process.execPath).arrayBuffer());
			using release = fakeRelease({
				"0.2.0": assets("chopin-windows-x64.exe", binary),
				"0.3.0": assets("chopin-windows-x64.exe", binary, sha256("something else")),
			});
			let local = await mkdtemp(join(scratch, "localappdata-"));
			let chopin = join(local, "chopin", "bin", "chopin.exe");
			let env = { ...release.env, LOCALAPPDATA: local, CHOPIN_VERIFY_ATTESTATION: "0" };
			let userPath = readUserPath();
			try {
				// The newest release, 0.3.0, does not match its checksum.
				let refused = await install(env);
				expect(refused.code).not.toBe(0);
				expect(refused.output).toContain("Refusing to install it.");
				expect(await Bun.file(chopin).exists()).toBe(false);

				let result = await install(env, "0.2.0");
				expect(result.code, result.output).toBe(0);
				expect(sha256(await Bun.file(chopin).bytes())).toBe(sha256(binary));
				expect(result.output).toContain(`Installed ${Bun.version}`);
				expect(release.requests).toContain("/api/releases");
				let added = readUserPath();
				expect(added.split(";")).toContain(join(local, "chopin", "bin"));
			} finally {
				Bun.spawnSync([
					pwsh!,
					"-NoProfile",
					"-Command",
					`[Environment]::SetEnvironmentVariable('Path', '${
						userPath.replaceAll("'", "''")
					}', 'User')`,
				]);
			}
		},
		120_000,
	);

	test.skipIf(!pwsh || process.platform !== "win32")(
		"refuses to install over a directory at chopin.exe",
		async () => {
			let binary = new Uint8Array(await Bun.file(process.execPath).arrayBuffer());
			using release = fakeRelease({ "0.2.0": assets("chopin-windows-x64.exe", binary) });
			let local = await mkdtemp(join(scratch, "localappdata-"));
			let chopin = join(local, "chopin", "bin", "chopin.exe");
			await mkdir(chopin, { recursive: true });
			let result = await install(
				{ ...release.env, LOCALAPPDATA: local, CHOPIN_VERIFY_ATTESTATION: "0" },
				"0.2.0",
			);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain(`${chopin} is a directory`);
			expect(await readdir(chopin)).toEqual([]);
		},
		120_000,
	);

	test.skipIf(!pwsh || process.platform !== "win32")(
		"installs a fresh chopin.exe where an interrupted update left only chopin.exe.old",
		async () => {
			let binary = new Uint8Array(await Bun.file(process.execPath).arrayBuffer());
			using release = fakeRelease({ "0.2.0": assets("chopin-windows-x64.exe", binary) });
			let local = await mkdtemp(join(scratch, "localappdata-"));
			let bin = join(local, "chopin", "bin");
			await mkdir(bin, { recursive: true });
			await writeFile(join(bin, "chopin.exe.old"), "the chopin an update moved aside");
			let userPath = readUserPath();
			try {
				let result = await install(
					{ ...release.env, LOCALAPPDATA: local, CHOPIN_VERIFY_ATTESTATION: "0" },
					"0.2.0",
				);
				expect(result.code, result.output).toBe(0);
				expect(result.output).toContain("left by an interrupted chopin update");
				expect(await readdir(bin)).toEqual(["chopin.exe"]);
				expect(sha256(await Bun.file(join(bin, "chopin.exe")).bytes())).toBe(sha256(binary));
			} finally {
				Bun.spawnSync([
					pwsh!,
					"-NoProfile",
					"-Command",
					`[Environment]::SetEnvironmentVariable('Path', '${
						userPath.replaceAll("'", "''")
					}', 'User')`,
				]);
			}
		},
		120_000,
	);
});
