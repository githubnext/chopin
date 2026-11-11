import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const ROOT = new URL("../", import.meta.url);
const WEB = new URL("apps/web", ROOT).pathname;
const GALLERY = new URL("apps/web/src/chat/image-gallery.tsx", ROOT).pathname;
const PICTURE = `data:image/png;base64,${
	readFileSync(new URL("./fixtures/raster-18x6.png", import.meta.url)).toString("base64")
}`;
const ORIGIN = "https://gallery.test";

const PAGE =
	`<!doctype html><html><body><div id="root"></div><script type="module" src="/gallery.js"></script></body></html>`;

const HARNESS = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ImageGallery } from ${JSON.stringify(GALLERY)};

window.__opened = [];
let images = Array.from({ length: 8 }, (_, index) => ({ src: ${
	JSON.stringify(PICTURE)
}, alt: "Tile " + (index + 1) }));
createRoot(document.getElementById("root")).render(
	createElement(ImageGallery, { images, onOpen: index => window.__opened.push(index) }),
);
`;

async function bundleGallery(): Promise<Map<string, string>> {
	let built = await Bun.build({
		entrypoints: ["harness:gallery"],
		target: "browser",
		splitting: true,
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [{
			name: "gallery-harness",
			setup(build) {
				build.onResolve({ filter: /^harness:gallery$/ }, () => ({
					path: "harness:gallery",
					namespace: "harness",
				}));
				build.onLoad({ filter: /.*/, namespace: "harness" }, () => ({
					contents: HARNESS,
					loader: "js",
				}));
				build.onResolve({ filter: /^@\// }, ({ path }) => ({
					path: Bun.resolveSync(`./src/${path.slice(2)}`, WEB),
				}));
				build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, ({ path }) => ({
					path: Bun.resolveSync(path, WEB),
				}));
				build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
			},
		}],
	});
	expect(built.success, built.logs.join("\n")).toBe(true);
	let files = new Map<string, string>();
	for (let output of built.outputs) {
		files.set(
			output.path.replace(/^\.\//, "").replace("harness:gallery", "gallery"),
			await output.text(),
		);
	}
	return files;
}

test("opening a gallery tile tells onOpen which tile it was, by its picture, its Open button or the keyboard, and the lightbox still opens", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	let files = await bundleGallery();
	await page.route(`${ORIGIN}/**`, route => {
		let name = new URL(route.request().url()).pathname.slice(1);
		return name
			? route.fulfill({ body: files.get(name), contentType: "text/javascript" })
			: route.fulfill({ body: PAGE, contentType: "text/html" });
	});
	await page.goto(`${ORIGIN}/`);

	let tiles = page.locator('[data-chat-image="tile"]');
	await expect(tiles).toHaveCount(6);
	for (let tile of await tiles.all()) await expect(tile).toHaveAttribute("data-load", "shown");
	let opened = () => page.evaluate(() => (window as unknown as { __opened: number[] }).__opened);
	let lightbox = page.locator('[data-slot="dialog-content"]');

	await tiles.nth(2).locator("img").click();
	await expect(lightbox.getByRole("status")).toHaveText("Image 3 of 8");
	expect(await opened()).toEqual([2]);
	await page.keyboard.press("ArrowRight");
	await expect(lightbox.getByRole("status")).toHaveText("Image 4 of 8");
	expect(await opened()).toEqual([2]);
	await page.keyboard.press("Escape");
	await expect(lightbox).toHaveCount(0);

	await tiles.nth(4).click();
	await expect(lightbox.getByRole("status")).toHaveText("Image 5 of 8");
	expect(await opened()).toEqual([2, 4]);
	await page.keyboard.press("Escape");
	await expect(lightbox).toHaveCount(0);

	let first = tiles.nth(0);
	await first.focus();
	await page.keyboard.press("Enter");
	await expect(lightbox.getByRole("status")).toHaveText("Image 1 of 8");
	expect(await opened()).toEqual([2, 4, 0]);
	await page.keyboard.press("Escape");
	await expect(lightbox).toHaveCount(0);
	await expect(first).toBeFocused();
	await page.keyboard.press("Space");
	await expect(lightbox.getByRole("status")).toHaveText("Image 1 of 8");
	expect(await opened()).toEqual([2, 4, 0, 0]);
});
