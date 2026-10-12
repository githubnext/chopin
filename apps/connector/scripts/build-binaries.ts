import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";

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

export function hostTarget() {
	return `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

export async function buildBinaries(
	targets: readonly string[],
	outdir = join(PACKAGE, "dist"),
) {
	let { version } = await Bun.file(join(PACKAGE, "package.json")).json() as { version: string };
	let built: string[] = [];
	for (let target of targets) {
		let outfile = join(outdir, binaryName(target));
		let result = Bun.spawnSync([
			process.execPath,
			"build",
			join(PACKAGE, "src/main.ts"),
			"--compile",
			"--minify",
			"--sourcemap",
			`--target=${target}`,
			"--define",
			`CHOPIN_CLI_VERSION=${JSON.stringify(version)}`,
			"--outfile",
			outfile,
		], { stdout: "pipe", stderr: "pipe" });
		if (!result.success) {
			throw new Error(`bun build --compile failed for ${target}:\n${result.stderr}`);
		}
		// The binary embeds its own source map; the copy beside it would only be shipped by mistake.
		await rm(`${outfile}.map`, { force: true });
		built.push(outfile);
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
