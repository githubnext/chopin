import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serve } from "./client";

async function createClient(files: Record<string, string>) {
	let directory = await mkdtemp(join(tmpdir(), "chopin-client-"));
	for (let [path, contents] of Object.entries(files)) {
		let file = join(directory, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	return {
		get: (path: string) => serve(new URL(path, "http://chopin.test"), directory),
		directory,
		close: () => rm(directory, { recursive: true, force: true }),
	};
}

test("fingerprinted Vite assets receive immutable caching", async () => {
	let client = await createClient({ "assets/index-AjK9nqi6.js": "console.log('build');" });
	try {
		let response = await client.get("/assets/index-AjK9nqi6.js");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await response.text()).toBe("console.log('build');");
	} finally {
		await client.close();
	}
});

test("unfingerprinted public files are not cached as immutable", async () => {
	let client = await createClient({
		"manifest.webmanifest": "{}",
		"icons/favicon.svg": "<svg />",
		"demo/felix.svg": "<svg />",
		"assets/chopin.js": "console.log('fixed');",
	});
	try {
		for (
			let path of [
				"/manifest.webmanifest",
				"/icons/favicon.svg",
				"/demo/felix.svg",
				"/assets/chopin.js",
			]
		) {
			let response = await client.get(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).not.toBe(
				"public, max-age=31536000, immutable",
			);
		}
	} finally {
		await client.close();
	}
});

test("HTML and SPA fallbacks are revalidated", async () => {
	let client = await createClient({ "index.html": "<!doctype html><main>app</main>" });
	try {
		for (let path of ["/index.html", "/rooms/room-123", "/assets", "/assetsx/app.js"]) {
			let response = await client.get(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-cache");
			expect(response.headers.get("content-type")).toContain("text/html");
			expect(await response.text()).toContain("<main>app</main>");
		}
	} finally {
		await client.close();
	}
});

test("a missing file under /assets answers 404, where the app's HTML would fail as a script", async () => {
	let client = await createClient({
		"index.html": "<!doctype html><main>app</main>",
		"assets/index-AjK9nqi6.js": "console.log('build');",
	});
	try {
		for (
			let path of [
				"/assets/old-chunk-Zy8wXq1p.js",
				"/assets/old-style-Zy8wXq1p.css",
				"/assets/unhashed.js",
				"/assets/nested/dir/chunk-Zy8wXq1p.js",
				"/assets/",
			]
		) {
			let response = await client.get(path);
			expect([path, response.status]).toEqual([path, 404]);
			expect(response.headers.get("content-type")).not.toContain("text/html");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.text()).not.toContain("<main>app</main>");
		}
		let present = await client.get("/assets/index-AjK9nqi6.js");
		expect(present.status).toBe(200);
		expect(present.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	} finally {
		await client.close();
	}
});

test("a missing built client keeps its existing 404 response", async () => {
	let directory = await mkdtemp(join(tmpdir(), "chopin-client-"));
	try {
		let response = await serve(new URL("http://chopin.test/"), join(directory, "missing"));
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(response.headers.get("cache-control")).not.toBe(
			"public, max-age=31536000, immutable",
		);
		expect(await response.text()).toContain("bun run build");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
