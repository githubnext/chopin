import { join } from "node:path";
import { buildPreview, output } from "./build";
import { resourcePath } from "./resource-path";

let buildError = "";
async function rebuild() {
	try {
		await buildPreview();
		buildError = "";
	} catch (error) {
		buildError = error instanceof Error ? error.message : "Build failed.";
	}
}
if (!process.argv.includes("--built")) await rebuild();
let rebuilding: Promise<void> | undefined;
for (let port of [8810, 8811]) {
	Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			let url = new URL(request.url);
			if (port === 8810 && url.pathname === "/retry-build" && request.method === "POST") {
				rebuilding ??= rebuild().finally(() => {
					rebuilding = undefined;
				});
				await rebuilding;
				return Response.json({ ok: !buildError });
			}
			if (buildError && port === 8811) {
				return new Response("Preview build failed. Retry the local build.", {
					status: 503,
					headers: { "content-type": "text/plain" },
				});
			}
			let path = resourcePath(output, url.pathname);
			if (!path) return new Response("Not found", { status: 404 });
			let file = Bun.file(path);
			if (!await file.exists()) {
				if (port === 8810 && path === join(output, "index.html") && buildError) {
					return new Response(
						`<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview build failed</title><main><h1>Preview could not build</h1><p role="alert">Fix the local source, then retry.</p><button>Retry build</button></main><script>document.querySelector("button").onclick=async()=>{let button=document.querySelector("button");button.disabled=true;try{let response=await fetch("/retry-build",{method:"POST"});if((await response.json()).ok)location.reload();}finally{button.disabled=false;}}</script></html>`,
						{ headers: { "content-type": "text/html" } },
					);
				}
				return new Response("Not found", { status: 404 });
			}
			return new Response(file, {
				headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
			});
		},
	});
}
console.log("Local review: http://127.0.0.1:8810 (built preview: port 8811)");
