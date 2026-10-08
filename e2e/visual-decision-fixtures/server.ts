import { previewHeaders } from "../../apps/server/src/visual-preview/policy";
import { fixtureByDigest } from "./fixtures";

let appOrigin = new URL(
	process.env.VISUAL_PREVIEW_APP_ORIGIN ?? "http://127.0.0.1:8840",
).origin;
let previewOrigin = new URL(
	process.env.VISUAL_PREVIEW_ORIGIN ?? "http://localhost:8841",
).origin;
let port = Number(process.env.VISUAL_PREVIEW_PORT ?? "8841");

let server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		let url = new URL(request.url);
		if (request.headers.get("host") !== new URL(previewOrigin).host) {
			return new Response(null, { status: 421 });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		if (url.pathname === "/health") return new Response("ok");
		let match = /^\/bundles\/([0-9a-f]{64})\/bundle\.html$/.exec(url.pathname);
		if (!match) return new Response(null, { status: 404 });
		let fixture = await fixtureByDigest(`sha256:${match[1]}`);
		if (!fixture) return new Response(null, { status: 404 });
		return new Response(
			request.method === "HEAD" ? null : Buffer.from(fixture.artifact.bytes),
			{
				headers: {
					...previewHeaders(fixture.csp, appOrigin),
					"content-type": "text/html; charset=utf-8",
				},
			},
		);
	},
});

console.log(`Fixture visual preview listening on ${server.hostname}:${server.port}`);
