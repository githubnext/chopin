import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { implementationBridge } from "./implementation";
import { remote } from "./mcp";

/**
 * A run's MCP bridge as its microVM runs it, under the image's Node: Chopin's tools for the run,
 * through the guest's proxy, and `upload_image_file` for an image in the run's repository, which
 * is in the guest. Bundled for Node into `chopin-guest-bridge.mjs` (see `guestBridge`).
 */
let api = await remote(
	new URL(process.env.CHOPIN_BRIDGE_ORIGIN!).origin,
	process.env.CHOPIN_BRIDGE_TOKEN!,
);
let server = await implementationBridge(api, process.env.CHOPIN_BRIDGE_ROOT);
await server.connect(new StdioServerTransport());
let close = async () => {
	await server.close();
	await api.close();
	process.exit(0);
};
process.stdin.once("end", close);
process.once("SIGTERM", close);
