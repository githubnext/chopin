import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { cardGapBinding } from "./card-gap.fixture";
import type { Page } from "@playwright/test";
let script: string, stylesheet: string;
let pageErrors = new WeakMap<Page, string[]>();
export async function prepareCardGap() {
	let entry = fileURLToPath(
		new URL("../../packages/editor/src/widgets/card-gap.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-card-gap-binding",
			setup(build) {
				build.onLoad(
					{ filter: /\/card-gap\.tsx$/ },
					async args => ({
						loader: "tsx",
						contents: await Bun.file(args.path).text() + "\n" + cardGapBinding,
					}),
				);
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	let outputs = result.outputs.filter(output => output.path.endsWith(".js"));
	expect(outputs).toHaveLength(1);
	script = await outputs[0]!.text();
	let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
	let files = await readdir(assets);
	let main = files.filter(name => /^index-.*\.css$/.test(name));
	let editor = files.filter(name => /^plan-editor-.*\.css$/.test(name));
	expect(main).toHaveLength(1);
	expect(editor).toHaveLength(1);
	stylesheet =
		(await Promise.all([main[0]!, editor[0]!].map(name => readFile(assets + name, "utf8")))).join(
			"\n",
		);
	expect(stylesheet).toContain(".plan-content");
}
export let active = { canEdit: true, connected: true, synced: true };
export async function loadCardGap(page: Page, flags = active, selection?: "caret" | "range") {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	pageErrors.set(page, errors);
	let url = "https://card-gap.invalid/";
	await page.route(
		"**/*",
		route =>
			route.request().url() === url && route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body: '<!doctype html><html><head></head><body><div id="fixture"></div></body></html>',
				})
				: route.abort(),
	);
	await page.goto(url);
	expect(await page.evaluate(() => ({ mode: document.compatMode, secure: isSecureContext })))
		.toEqual({ mode: "CSS1Compat", secure: true });
	await page.addStyleTag({ content: stylesheet });
	// Only native fixture host dimensions; production styles render the actual cards.
	await page.addStyleTag({ content: "body{margin:0}[data-gap-host]{width:500px;margin:24px}" });
	await page.addScriptTag({ content: script });
	await page.evaluate(({ flags, selection }) => window.cardGapFixture.mount(flags, selection), {
		flags,
		selection,
	});
	await expect.poll(() => page.evaluate(() => window.cardGapFixture.ready())).toBe(true);
}
export async function paintGap(page: Page) {
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
}
export async function compacted(page: Page) {
	await expect.poll(() =>
		page.evaluate(() => {
			let value = window.cardGapFixture.snapshot();
			return value.keys;
		})
	).toEqual(await page.evaluate(() => window.cardGapFixture.snapshot().expected));
	let value = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(value.types.filter(type => type === "plan-questionnaire")).toHaveLength(2);
	expect(value.types.filter(type => type === "plan-decision")).toHaveLength(2);
	expect(value.texts.filter(text => text === "Keep this exact prose.")).toHaveLength(1);
	expect(value.yjs.update.length).toBeGreaterThan(2);
	expect(value.yjs.xml).toBe(value.yjs.roundtrip);
	expect(value.yjs.xml).toContain("Keep this exact prose.");
	expect(value.yjs.blocks).toEqual(value.yjs.restoredBlocks);
	expect(value.yjs.blocks.map(block => block.type)).toEqual(value.types);
	expect(value.yjs.blocks.filter(block => block.type === "paragraph")).toHaveLength(6);
	return value;
}
export async function assertCardGapErrors(page: Page) {
	expect(pageErrors.get(page)).toEqual([]);
	expect(await page.evaluate(() => window.cardGapFixture.errors)).toEqual([]);
}
