import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The release install scripts, run against a local server that serves a fake release in the
 * layout GitHub uses: `<base>/cli-v<version>/<asset>` and the API's list of releases.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-install-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

type Content = string | Uint8Array<ArrayBuffer>;

function sha256(content: Content) {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function fakeRelease(releases: Record<string, Record<string, Content>>) {
	let requests: string[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			let path = new URL(request.url).pathname;
			requests.push(path);
			if (path === "/api/releases") {
				return Response.json(
					// Newest first, as GitHub lists them, among tags that are not CLI releases.
					[
						"color-controls-slice-4",
						...Object.keys(releases).toReversed().map(v => `cli-v${v}`),
					].map(tag => ({
						tag_name: tag,
						draft: false,
						prerelease: false,
					})),
				);
			}
			let [, tag, name] = path.split("/");
			let content = releases[tag.replace(/^cli-v/, "")]?.[name];
			return content === undefined
				? new Response("Not Found", { status: 404 })
				: new Response(content);
		},
	});
	let origin = `http://127.0.0.1:${server.port}`;
	return {
		requests,
		env: {
			CHOPIN_RELEASE_BASE_URL: origin,
			CHOPIN_RELEASES_API_URL: `${origin}/api/releases`,
		},
		[Symbol.dispose]: () => void server.stop(true),
	};
}

function fakeChopin(version: string) {
	return `#!/bin/sh\necho "chopin ${version} (connector protocol 1)"\n`;
}

/** A release's assets for one platform: the binary and a checksums.txt that lists it. */
function assets(name: string, binary: Content, checksum = sha256(binary)) {
	return {
		[name]: binary,
		"checksums.txt": `${"0".repeat(64)}  other-file\n${checksum}  ${name}\n`,
	};
}

// install.sh is for Linux and macOS; its shims are shell scripts that Windows cannot run.
describe.skipIf(process.platform === "win32")("install.sh", () => {
	let script = join(import.meta.dir, "install.sh");

	/** A fresh HOME, and shims for uname, gh and sudo that record how they were called. */
	async function machine(options: { os?: string; arch?: string; gh?: number } = {}) {
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
		let calls = async () =>
			(await Bun.file(log).exists()) ? (await readFile(log, "utf8")).trim() : "";
		return { home, shims, calls, chopin: join(home, ".local/bin/chopin") };
	}

	async function install(
		at: Awaited<ReturnType<typeof machine>>,
		env: Record<string, string>,
		...args: string[]
	) {
		// Asynchronous: the fake release is served from this process.
		let child = Bun.spawn(["sh", script, ...args], {
			env: { HOME: at.home, PATH: `${at.shims}:${process.env.PATH}`, ...env },
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
});
