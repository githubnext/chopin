import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where a run's guest finds its MCP bridge, a file shared read-only with it. */
export const GUEST_BRIDGE_PATH = "/opt/chopin/bridge.mjs";

/** The name the `chopin` binary embeds the bridge's bundle under (see `build-binaries.ts`). */
export const EMBEDDED_BRIDGE = "chopin-guest-bridge";

/**
 * The bridge's bundle for Node, as a file in `<base>/nvx/bridge/`, named by its SHA-256: the one the
 * `chopin` binary carries, or, run from source, one built from `guest-bridge.ts` now.
 */
export async function guestBridge(base: string): Promise<string> {
	let bundle: Uint8Array;
	if (Bun.isStandaloneExecutable) {
		let files = Bun.embeddedFiles as Array<Blob & { name: string }>;
		let found = files.find(file => file.name.startsWith(EMBEDDED_BRIDGE));
		if (!found) throw new Error("This chopin has no MCP bridge for its microVMs.");
		bundle = new Uint8Array(await found.arrayBuffer());
	} else {
		let built = await Bun.build({
			entrypoints: [join(import.meta.dir, "guest-bridge.ts")],
			target: "node",
			format: "esm",
			minify: true,
		});
		if (!built.success || !built.outputs[0]) {
			throw new Error(`Couldn't build the MCP bridge for microVMs: ${built.logs.join("\n")}`);
		}
		bundle = new Uint8Array(await built.outputs[0].arrayBuffer());
	}
	let folder = join(base, "nvx", "bridge");
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	let path = join(folder, `${createHash("sha256").update(bundle).digest("hex").slice(0, 16)}.mjs`);
	if (!existsSync(path)) writeFileSync(path, bundle, { mode: 0o644 });
	return path;
}

/** How a run's agent starts its MCP bridge in its guest: the image's Node on the bundle. */
export function guestBridgeCommand() {
	return { command: "/opt/chopin/agent/node/bin/node", args: [GUEST_BRIDGE_PATH] };
}
