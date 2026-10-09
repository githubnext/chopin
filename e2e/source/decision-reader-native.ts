import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { decisionReaderBinding } from "./decision-reader.fixture";
import type { Page } from "@playwright/test";

let script: string;
let stylesheet: string;
let nativeErrors = new WeakMap<Page, string[]>();
export async function prepareReader() {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let entry = fileURLToPath(
		new URL("../../packages/editor/src/resolved-layer.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-decision-reader-binding",
			setup(build) {
				build.onLoad(
					{ filter: /\/resolved-layer\.tsx$/ },
					async args => ({
						loader: "tsx",
						contents: await Bun.file(args.path).text() + "\n" + decisionReaderBinding,
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
	let names = files.filter(name => /^index-.*\.css$/.test(name));
	expect(names).toHaveLength(1);
	let styles = await Promise.all(
		files.filter(name => name.endsWith(".css")).map(async name => ({
			name,
			content: await readFile(assets + name, "utf8"),
		})),
	);
	let editorStyles = styles.filter(style => style.content.includes(".plan-decision-marker"));
	expect(editorStyles).toHaveLength(1);
	stylesheet = [
		styles.find(style => style.name === names[0])!.content,
		editorStyles[0]!.content,
	].join("\n");
	expect(stylesheet).toContain(".plan-decision-marker");
}
export let reader = (page: Page, index = 0) => page.locator(`[data-reader="${index}"]`);
export let marker = (page: Page, index = 0) =>
	reader(page, index).getByRole("button", { name: "Decision: GitHub Apps", exact: true });
export let dialog = (page: Page, index = 0) =>
	reader(page, index).getByRole("dialog", { name: "Decision", exact: true });
export let tooltip = (page: Page, index = 0) => reader(page, index).getByRole("tooltip");
export async function loadReader(page: Page, readonly = true, count = 1) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	nativeErrors.set(page, errors);
	let url = "https://decision-reader.invalid/";
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
	expect(await page.evaluate(() => ({ mode: document.compatMode, secure: window.isSecureContext })))
		.toEqual({ mode: "CSS1Compat", secure: true });
	await page.addStyleTag({ content: stylesheet });
	// Only isolated host dimensions; all reader chrome comes from current compiled production CSS.
	await page.addStyleTag({
		content: `
		body { margin:0; }
		[data-reader-host] { display:flex; gap:24px; padding:24px; }
		[data-reader] { flex:none; width:min(420px,calc(100vw - 48px)); height:400px; }
		[data-reader] > [data-plan-scroll] { height:100%; overflow:auto; }
	`,
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(
		({ readonly, count }) => window.decisionReaderFixture.mount(readonly, count),
		{ readonly, count },
	);
	await expect.poll(() => page.evaluate(() => window.decisionReaderFixture.ready())).toBe(true);
	await expect(marker(page)).toBeVisible();
	expect(errors).toEqual([]);
	return errors;
}

export async function assertReaderErrors(page: Page) {
	expect(nativeErrors.get(page) ?? []).toEqual([]);
	expect(await page.evaluate(() => window.decisionReaderFixture.errors)).toEqual([]);
}
