import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EMBEDDED_BRIDGE } from "../src/bridge";
import { bridgeBundle } from "./build-binaries";

test("each binary carries the MCP bridge its microVMs run, bundled for Node with nothing of Bun", async () => {
	let scratch = await mkdtemp(join(tmpdir(), "chopin-bridge-bundle-"));
	try {
		let path = await bridgeBundle(scratch);
		// No extension, so the compiled binary embeds it as a file and doesn't run it.
		expect(basename(path)).toBe(EMBEDDED_BRIDGE);
		let bundle = await readFile(path, "utf8");
		expect(bundle).not.toContain("Bun.");
		expect(bundle).toContain("CHOPIN_BRIDGE_ORIGIN");
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
