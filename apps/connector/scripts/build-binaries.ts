import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * Compile the connector into standalone `chopin` executables that run without Bun installed.
 *
 *   bun run --cwd apps/connector build:binaries            # every release target
 *   bun run --cwd apps/connector build:binaries --host     # this machine only
 *   bun run --cwd apps/connector build:binaries bun-linux-x64
 */
export const TARGETS = [
	"bun-linux-x64",
	"bun-linux-arm64",
	"bun-darwin-x64",
	"bun-darwin-arm64",
	"bun-windows-x64",
] as const;

const PACKAGE = join(import.meta.dir, "..");

/** `chopin-<os>-<arch>`, with `.exe` on Windows. */
export function binaryName(target: string) {
	let name = target.replace(/^bun-/, "chopin-");
	return target.includes("windows") ? `${name}.exe` : name;
}

/**
 * The MXC executor a target's binary carries, and the files beside it that it needs, from the SDK
 * package: the sandbox each system runs agents in. The executor is written out of the binary on
 * first use (see `locateExecutor`), so each is embedded under a fixed name. Intel Macs have none:
 * MXC's Seatbelt backend is built for Apple silicon.
 */
export function mxcExecutors(target: string): Array<{ from: string; as: string }> {
	let [, system, arch] = target.split("-") as [string, string, string];
	let bin = join(
		dirname(createRequire(import.meta.url).resolve("@microsoft/mxc-sdk/package.json")),
		"bin",
		arch,
	);
	let files: Array<[string, string]> = system === "linux"
		? [["lxc-exec", "mxc-executor"]]
		: system === "darwin" && arch === "arm64"
		? [["mxc-exec-mac", "mxc-executor"]]
		: system === "windows"
		? [["wxc-exec.exe", "mxc-executor.exe"], [
			"winhttp-proxy-shim.exe",
			"mxc-winhttp-proxy-shim.exe",
		]]
		: [];
	return files.map(([from, as]) => {
		let path = join(bin, from);
		if (!existsSync(path)) throw new Error(`The MXC SDK has no ${from} for ${target}: ${path}`);
		return { from: path, as };
	});
}

export function hostTarget() {
	return `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

export async function buildBinaries(
	targets: readonly string[],
	outdir = join(PACKAGE, "dist"),
) {
	let { version } = await Bun.file(join(PACKAGE, "package.json")).json() as { version: string };
	let built: string[] = [];
	// `bun build --compile` stages each executable as `.<hash>.bun-build` in its working directory
	// and leaves it there if interrupted, so it works in a scratch directory removed afterwards.
	let scratch = await mkdtemp(join(tmpdir(), "chopin-build-"));
	try {
		for (let target of targets) {
			let outfile = resolve(outdir, binaryName(target));
			let embedded: string[] = [];
			for (let { from, as } of mxcExecutors(target)) {
				let staged = join(scratch, as);
				await copyFile(from, staged);
				embedded.push(staged);
			}
			let result = Bun.spawnSync([
				process.execPath,
				"build",
				join(PACKAGE, "src/main.ts"),
				...embedded,
				"--compile",
				// An installed binary runs inside people's checkouts. Their .env must not choose its
				// server, and their bunfig.toml (a `preload`, say) must not run code in it.
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				"--no-compile-autoload-tsconfig",
				"--no-compile-autoload-package-json",
				"--minify",
				"--sourcemap",
				`--target=${target}`,
				"--define",
				`CHOPIN_CLI_VERSION=${JSON.stringify(version)}`,
				"--outfile",
				outfile,
			], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
			if (!result.success) {
				throw new Error(`bun build --compile failed for ${target}:\n${result.stderr}`);
			}
			// The binary embeds its own source map; the copy beside it would only be shipped by mistake.
			await rm(`${outfile}.map`, { force: true });
			// Each embedded executor gets a map of its own, which is no use to anyone.
			for (let file of embedded) {
				await rm(join(dirname(outfile), `${basename(file).replace(/\.exe$/, "")}.js.map`), {
					force: true,
				});
			}
			built.push(outfile);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	return built;
}

if (import.meta.main) {
	let args = process.argv.slice(2);
	let targets = args.includes("--host") ? [hostTarget()] : args.length ? args : TARGETS;
	for (let file of await buildBinaries(targets)) {
		let megabytes = (statSync(file).size / 1024 / 1024).toFixed(1);
		console.log(`${relative(process.cwd(), file)}  ${megabytes} MB`);
	}
}
