import { expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerConnectorScript } from "./connector-script";
import { Router } from "./router";

async function serve(files: { bundle?: string; source?: string }) {
	let directory = await mkdtemp(join(tmpdir(), "chopin-connector-script-"));
	let bundle = join(directory, "connector.js");
	let source = join(directory, "main.ts");
	if (files.bundle !== undefined) await writeFile(bundle, files.bundle);
	if (files.source !== undefined) await writeFile(source, files.source);
	let router = new Router();
	registerConnectorScript(router, { bundle, source });
	let get = async (headers: HeadersInit = {}, method = "GET") =>
		(await router.handle(new Request("http://chopin.test/connector.js", { method, headers })))!;
	return { get, bundle, close: () => rm(directory, { recursive: true, force: true }) };
}

test("GET /connector.js serves the built bundle without authentication", async () => {
	let script = await serve({ bundle: "console.log('connector');" });
	try {
		let response = await script.get();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(await response.text()).toBe("console.log('connector');");
		let etag = response.headers.get("etag");
		expect(etag).toMatch(/^"[\w-]+"$/);

		let revalidated = await script.get({ "if-none-match": etag! });
		expect(revalidated.status).toBe(304);
		let head = await script.get({}, "HEAD");
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");

		// A new build is a new ETag, so the next download replaces a stale copy.
		await writeFile(script.bundle, "console.log('deployed');");
		await utimes(script.bundle, new Date(), new Date(Date.now() + 5000));
		let changed = await script.get({ "if-none-match": etag! });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(etag);
		expect(await changed.text()).toBe("console.log('deployed');");
	} finally {
		await script.close();
	}
});

test("without a build the connector is bundled from source", async () => {
	let script = await serve({ source: "export let x: number = 1;\nconsole.log(x);\n" });
	try {
		let response = await script.get();
		expect(response.status).toBe(200);
		let text = await response.text();
		expect(text).toContain("console.log");
		expect(text).not.toContain(": number");
	} finally {
		await script.close();
	}
});

test("a server with neither bundle nor source says how to build one", async () => {
	let script = await serve({});
	try {
		let response = await script.get();
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("bun run build");
	} finally {
		await script.close();
	}
});
