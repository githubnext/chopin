import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { sourceFixture } from "./transcript-source.fixture";

import type { Page } from "@playwright/test";

declare global {
	interface Window {
		transcriptFixture: {
			mount: () => void;
			unmount: () => void;
			select: (id: string) => void;
			clear: () => void;
			activate: (active: boolean) => void;
			change: (id: string, text: string) => void;
			append: () => void;
		};
	}
}

let script: string;
let stylesheet: string;

test.beforeAll(async () => {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let entry = fileURLToPath(new URL("../../apps/web/src/chat/transcript.tsx", import.meta.url));
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "transcript-source-test-binding",
			setup(build) {
				build.onLoad({ filter: /\/chat\/transcript\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + "\n" + sourceFixture,
				}));
			},
		}],
	});
	expect(result.success).toBe(true);
	let scripts = result.outputs.filter(output => output.path.endsWith(".js"));
	let styles = result.outputs.filter(output => output.path.endsWith(".css"));
	expect(scripts).toHaveLength(1);
	expect(styles).toHaveLength(1);
	script = await scripts[0]!.text();
	stylesheet = await styles[0]!.text();
});

async function load(page: Page) {
	await page.route("**/*", route => route.abort());
	// Geometry is provided by this isolated host; all transcript markup and behavior are production.
	await page.setContent(`<main><div id="fixture"></div></main>`);
	await page.addStyleTag({ content: stylesheet });
	await page.addStyleTag({
		content: `
		body { margin:0; font:16px sans-serif; }
		main { width:400px; margin:40px; }
		[data-focus-boundary] { height:240px; overflow:auto; }
		[data-chat-stack] { display:flex; flex-direction:column; gap:16px; min-height:100%; }
	`,
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(() => window.transcriptFixture.mount());
	await expect(page.locator('[data-chat-message-id="m23"]')).toBeVisible();
}

async function ranges(page: Page) {
	return page.evaluate(() =>
		Array.from(CSS.highlights.get("conversation-source") ?? [], range => ({
			quote: range.toString(),
			rects: range instanceof Range ? range.getClientRects().length : 0,
		}))
	);
}

async function select(page: Page, id: string) {
	await page.evaluate(id => window.transcriptFixture.select(id), id);
	await expect(page.locator(`[data-chat-message-id="${id}"]`)).toHaveAttribute(
		"data-chat-source",
		"true",
	);
}

test("a destination scrolls its actual source into view and replaces only its highlight", async ({ page }) => {
	await load(page);
	await select(page, "m7");
	let source = page.locator('[data-chat-message-id="m7"]');
	await expect(source).toHaveAttribute("data-source-exact", "true");
	expect(await ranges(page)).toMatchObject([{ quote: "A🧪 pilot" }]);
	expect((await ranges(page))[0]!.rects).toBeGreaterThan(0);
	let centered = await source.evaluate(element => {
		let scroll = element.closest("[data-focus-boundary]")!.getBoundingClientRect();
		let source = element.getBoundingClientRect();
		return Math.abs(source.top + source.height / 2 - scroll.top - scroll.height / 2);
	});
	expect(centered).toBeLessThan(3);
	await select(page, "m8");
	await expect(source).not.toHaveAttribute("data-source-exact", "true");
	await expect(source).not.toHaveAttribute("data-chat-source", "true");
	await expect(page.locator('[data-chat-message-id="m8"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	expect(await ranges(page)).toMatchObject([{ quote: "A🧪 pilot" }]);
});

test("missing, stale and transformed Markdown destinations clear or refuse exact highlighting", async ({ page }) => {
	await load(page);
	await select(page, "m7");
	await page.evaluate(() => window.transcriptFixture.select("missing"));
	await expect.poll(() => ranges(page)).toEqual([]);
	await expect(page.locator("[data-source-exact]")).toHaveCount(0);
	await select(page, "m10");
	await expect(page.locator('[data-chat-message-id="m10"] strong')).toHaveText("Bold");
	await expect(page.locator('[data-chat-message-id="m10"]')).toHaveAttribute(
		"data-source-exact",
		"false",
	);
	expect(await ranges(page)).toEqual([]);
	await page.evaluate(() =>
		window.transcriptFixture.change("m7", "Changed since the saved quote.")
	);
	await select(page, "m7");
	await expect(page.locator('[data-chat-message-id="m7"]')).toHaveAttribute(
		"data-source-exact",
		"false",
	);
	expect(await ranges(page)).toEqual([]);
});

test("clearing, deactivating and unmounting clean up the source owner and DOM marker", async ({ page }) => {
	await load(page);
	await select(page, "m7");
	await page.evaluate(() => window.transcriptFixture.clear());
	await expect.poll(() => ranges(page)).toEqual([]);
	await expect(page.locator("[data-source-exact]")).toHaveCount(0);
	await select(page, "m8");
	await page.evaluate(() => window.transcriptFixture.activate(false));
	await expect.poll(() => ranges(page)).toEqual([]);
	await expect(page.locator("[data-source-exact]")).toHaveCount(0);
	await page.evaluate(() => window.transcriptFixture.activate(true));
	await expect(page.locator('[data-chat-message-id="m8"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	await page.evaluate(() => window.transcriptFixture.unmount());
	await expect.poll(() => ranges(page)).toEqual([]);
	await expect(page.locator("[data-chat-message-id]")).toHaveCount(0);
	await page.evaluate(() => window.transcriptFixture.mount());
	await select(page, "m7");
	expect(await ranges(page)).toMatchObject([{ quote: "A🧪 pilot" }]);
});

test("manual scrolling preserves unpinned appends and resumes bottom pinning", async ({ page }) => {
	await load(page);
	let scroller = page.locator("[data-focus-boundary]");
	await scroller.evaluate(async element => {
		element.scrollTop = 0;
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	await expect(scroller).toHaveJSProperty("scrollTop", 0);
	await page.evaluate(() => window.transcriptFixture.append());
	await expect(page.locator('[data-chat-message-id="m24"]')).toHaveCount(1);
	await expect(scroller).toHaveJSProperty("scrollTop", 0);
	await scroller.evaluate(async element => {
		element.scrollTop = element.scrollHeight;
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	let previous = await scroller.evaluate(element => element.scrollTop);
	await page.evaluate(() => window.transcriptFixture.append());
	await expect(page.locator('[data-chat-message-id="m25"]')).toHaveCount(1);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(
		previous,
	);
	await select(page, "m7");
	let sourcePosition = await scroller.evaluate(element => element.scrollTop);
	await page.evaluate(() => window.transcriptFixture.append());
	await expect(page.locator('[data-chat-message-id="m26"]')).toHaveCount(1);
	await expect(scroller).toHaveJSProperty("scrollTop", sourcePosition);
});
