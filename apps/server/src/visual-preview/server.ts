import { visualBundle } from "./descriptor";
import { previewHeaders } from "./policy";
import { previewOrigin } from "./site";

export async function startVisualPreview() {
	let appOrigin = new URL(process.env.VISUAL_PREVIEW_APP_ORIGIN ?? "http://127.0.0.1:8787").origin;
	let origin = previewOrigin(
		appOrigin,
		process.env.VISUAL_PREVIEW_ORIGIN ?? "http://localhost:8793",
	);
	if (!origin) throw new Error("Visual preview origin is required");
	let expectedHost = new URL(origin).host;
	let { manifest, bytes } = await visualBundle();
	return Bun.serve({
		hostname: process.env.VISUAL_PREVIEW_HOST ?? "127.0.0.1",
		port: Number(process.env.VISUAL_PREVIEW_PORT ?? "8793"),
		fetch(request) {
			let url = new URL(request.url);
			if (request.headers.get("host") !== expectedHost) return new Response(null, { status: 421 });
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response(null, { status: 405 });
			}
			let prefix = `/bundles/${manifest.bundle.sha256}/`;
			let headers = previewHeaders(manifest, appOrigin);
			if (url.pathname === `${prefix}manifest.json`) {
				return Response.json(manifest, { headers });
			}
			if (url.pathname === `${prefix}bundle.html`) {
				return new Response(request.method === "HEAD" ? null : Buffer.from(bytes), {
					headers: { ...headers, "content-type": "text/html; charset=utf-8" },
				});
			}
			if (url.pathname === "/health") return new Response("ok");
			return new Response(null, { status: 404 });
		},
	});
}

if (import.meta.main) {
	let server = await startVisualPreview();
	console.log(`Visual preview listening on ${server.hostname}:${server.port}`);
}
