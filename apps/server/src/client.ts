/**
 * Serving the browser client.
 *
 * One origin in every mode. In production the built files come off disk; in
 * development everything that is not the socket is forwarded to a running
 * Vite. Either way the browser talks to exactly one host and port, so the
 * client can derive its socket URL from `location` and be correct locally, on
 * a LAN address, and through a tunnel without being told which it is.
 *
 * Nothing proxies a WebSocket. This server owns `/ws` natively, and Vite's
 * hot-reload socket is pointed at Vite's own port — so the one piece of
 * machinery that would have to relay an upgrade does not exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { entryOf } from "@chopin/protocol/restart";

/** Hop-by-hop headers, which describe one connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/** Credentials belong to the application server, never its development UI upstream. */
const PRIVATE = new Set(["authorization", "cookie"]);

/** Vite's default build names use an eight-character hash before the extension. */
const FINGERPRINTED_ASSET_PATH = /^\/assets\/.+-[A-Za-z0-9_-]{8}\.[^/]+$/;
const ASSETS_PATH = "/assets/";
/** Where the image keeps the hashed files of the builds before this one, beside the built client. */
const KEPT_ASSETS = "kept-assets";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function forwardable(headers: Headers): Headers {
	let out = new Headers();
	for (let [name, value] of headers) {
		let lower = name.toLowerCase();
		if (!HOP_BY_HOP.has(lower) && !PRIVATE.has(lower)) out.set(name, value);
	}
	return out;
}

/**
 * Hand a request to Vite.
 *
 * Vite serves the page, the module graph, and its own client script. It is a
 * separate process that may not be up yet — `bun run dev` starts both — so a
 * refused connection is answered with something that says as much rather than
 * a stack trace.
 */
export async function proxy(req: Request, url: URL, origin: string): Promise<Response> {
	let target = new URL(url.pathname + url.search, origin);
	let headers = forwardable(req.headers);
	// Vite is an internal upstream and must validate its own host, not the tunnel's.
	headers.set("host", target.host);

	try {
		return await fetch(target, {
			method: req.method,
			headers,
			body: req.body,
			redirect: "manual",
		});
	} catch {
		return new Response(`chopin: no dev client at ${origin}. Is Vite running?`, {
			status: 502,
			headers: { "content-type": "text/plain" },
		});
	}
}

/**
 * Serve the built client.
 *
 * Anything that is not a real file is the single-page app, so a room URL
 * survives a reload and a deep link opens the room it names. Under `/assets/` it
 * is a 404 instead: a page left open across a deploy asks for the chunks of the
 * build it came from, and HTML answering for a script is an error that names
 * nothing, where a 404 tells the page its build is gone. The last builds' hashed
 * files that the image kept are served from `kept`, so such a page still finds its chunks.
 */
export async function serve(
	url: URL,
	dir: string,
	kept = join(dir, "..", KEPT_ASSETS),
): Promise<Response> {
	if (!existsSync(dir)) {
		return new Response(
			"chopin: no built client. Run `bun run dev` for development, or `bun run build` first.",
			{ status: 404, headers: { "content-type": "text/plain" } },
		);
	}

	let file = Bun.file(join(dir, url.pathname));
	if (await file.exists()) {
		let headers = new Headers();
		if (FINGERPRINTED_ASSET_PATH.test(url.pathname)) {
			headers.set("cache-control", IMMUTABLE_CACHE_CONTROL);
		} else if (url.pathname.toLowerCase().endsWith(".html")) {
			headers.set("cache-control", "no-cache");
		}
		return new Response(file, { headers });
	}
	if (url.pathname.startsWith(ASSETS_PATH)) {
		// A file of a build the image kept from before: the same name always has the same content.
		if (FINGERPRINTED_ASSET_PATH.test(url.pathname)) {
			let previous = Bun.file(join(kept, url.pathname));
			if (await previous.exists()) {
				return new Response(previous, { headers: { "cache-control": IMMUTABLE_CACHE_CONTROL } });
			}
		}
		return new Response("not found", {
			status: 404,
			headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
		});
	}
	return new Response(Bun.file(join(dir, "index.html")), {
		headers: { "cache-control": "no-cache" },
	});
}

/**
 * The build of the client in `dir`: the entry script its page loads, which is also what a tab
 * reports as its own. Undefined when there is no built client, as in development.
 */
export function clientBuild(dir: string): string | undefined {
	try {
		return entryOf(readFileSync(join(dir, "index.html"), "utf8"));
	} catch {
		return undefined;
	}
}
