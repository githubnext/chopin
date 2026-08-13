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

import { existsSync } from "node:fs";
import { join } from "node:path";

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
 * survives a reload and a deep link opens the room it names.
 */
export async function serve(url: URL, dir: string): Promise<Response> {
	if (!existsSync(dir)) {
		return new Response(
			"chopin: no built client. Run `bun run dev` for development, or `bun run build` first.",
			{ status: 404, headers: { "content-type": "text/plain" } },
		);
	}

	let file = Bun.file(join(dir, url.pathname));
	if (await file.exists()) return new Response(file);
	return new Response(Bun.file(join(dir, "index.html")));
}
