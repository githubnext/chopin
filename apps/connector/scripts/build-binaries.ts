import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { EMBEDDED_BRIDGE } from "../src/bridge";

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
 * The MCP bridge a run's microVM runs on its image's Node (see `guestBridge`), bundled for Node and
 * written to `into` under the name the binary embeds it by: no extension, so the binary carries it
 * as a file, not as code of its own.
 */
export async function bridgeBundle(into: string) {
	let built = await Bun.build({
		entrypoints: [join(PACKAGE, "src/guest-bridge.ts")],
		target: "node",
		format: "esm",
		minify: true,
	});
	if (!built.success || !built.outputs[0]) {
		throw new Error(`Couldn't bundle the guest bridge:\n${built.logs.join("\n")}`);
	}
	let path = join(into, EMBEDDED_BRIDGE);
	await Bun.write(path, built.outputs[0]);
	return path;
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
			let embedded = [await bridgeBundle(scratch)];
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
			// The binary embeds its own source map; the copy beside it would only be shipped by mistake,
			// and so would the map the embedded bridge gets.
			await rm(`${outfile}.map`, { force: true });
			await rm(join(dirname(outfile), `${EMBEDDED_BRIDGE}.js.map`), { force: true });
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
