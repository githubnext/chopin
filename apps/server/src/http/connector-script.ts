import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import type { Router } from "./router";

type Script = { bytes: Uint8Array<ArrayBuffer>; etag: string };

/**
 * Serve the bundled local connector so `bun ~/.chopin/connector.js` works outside a Chopin checkout.
 *
 * A build writes the bundle beside the web client. Without one (development), the connector is
 * bundled from source on each request so it always matches the checkout. The ETag is the bundle's
 * hash and every download revalidates, so a deploy is picked up by the next download.
 */
export function registerConnectorScript(
	router: Router,
	options: { bundle: string; source: string },
): void {
	let cached: { mtime: number; script: Script } | undefined;
	async function current(): Promise<Script | undefined> {
		if (existsSync(options.bundle)) {
			let mtime = statSync(options.bundle).mtimeMs;
			if (cached?.mtime !== mtime) {
				cached = { mtime, script: tagged(await Bun.file(options.bundle).bytes()) };
			}
			return cached.script;
		}
		if (!existsSync(options.source)) return undefined;
		let built = await Bun.build({ entrypoints: [options.source], target: "bun" });
		let [output] = built.outputs;
		if (!built.success || !output) throw new Error("The connector failed to bundle.");
		return tagged(new Uint8Array(await output.arrayBuffer()));
	}
	let handler = async (request: Request) => {
		let script = await current();
		if (!script) {
			return new Response("chopin: no connector bundle. Run `bun run build` first.", {
				status: 404,
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			});
		}
		let headers = {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-cache",
			etag: script.etag,
			"x-content-type-options": "nosniff",
		};
		if (request.headers.get("if-none-match") === script.etag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(request.method === "HEAD" ? null : script.bytes, {
			headers: { ...headers, "content-length": String(script.bytes.byteLength) },
		});
	};
	router.on("GET", "/connector.js", handler);
	router.on("HEAD", "/connector.js", handler);
}

function tagged(bytes: Uint8Array<ArrayBuffer>): Script {
	return {
		bytes,
		etag: `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 32)}"`,
	};
}
