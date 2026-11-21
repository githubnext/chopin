import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { bridgeBundle } from "./build-binaries";

const PACKAGE = join(import.meta.dir, "..");

/**
 * Bundle the connector into `connector.js`, the script Chopin serves for `bun connector.js`, with
 * the MCP bridge its microVMs run defined in it (`CHOPIN_GUEST_BRIDGE`), as the `chopin` binary
 * embeds it: run from anywhere, the script has no source beside it to build the bridge from.
 */
export async function buildConnector(
	outfile = join(PACKAGE, "dist", "connector.js"),
	entry = join(PACKAGE, "src", "main.ts"),
) {
	let scratch = await mkdtemp(join(tmpdir(), "chopin-connector-"));
	try {
		let bridge = await Bun.file(await bridgeBundle(scratch)).text();
		let built = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			outdir: dirname(resolve(outfile)),
			naming: basename(outfile),
			define: { CHOPIN_GUEST_BRIDGE: JSON.stringify(bridge) },
		});
		if (!built.success) throw new Error(`Couldn't bundle the connector:\n${built.logs.join("\n")}`);
		return resolve(outfile);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) console.log(await buildConnector());
