import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { analysisHostBinding } from "./analysis-host.fixture";
import type { Page } from "@playwright/test";
import type { HostMode } from "./analysis-host.fixture";

let script: string, stylesheet: string;
export async function prepareAnalysisHost(): Promise<void> {
	if (typeof Bun === "undefined") throw new Error("Run through bun --bun");
	let entry = fileURLToPath(new URL("../../apps/web/src/chat/transcript.tsx", import.meta.url));
	let source = await Bun.file(entry).text();
	expect(source).toContain("<MessageMarkers");
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-analysis-host-binding",
			setup(build) {
				build.onLoad({ filter: /\/chat\/transcript\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + "\n" + analysisHostBinding,
				}));
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	let scripts = result.outputs.filter(output => output.path.endsWith(".js"));
	expect(scripts).toHaveLength(1);
	script = await scripts[0]!.text();
	// Root builds current web assets immediately before the native run. Use real compiled roles.
	let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
	let styles = (await readdir(assets)).filter(name => /^index-.*\.css$/.test(name));
	expect(styles).toHaveLength(1);
	stylesheet = await readFile(assets + styles[0]!, "utf8");
	expect(stylesheet).toContain(".motion-popover");
}
export let message = (page: Page, id: string) => page.locator(`[data-chat-message-id="${id}"]`);
export let analysis = (page: Page, id: string) => page.locator(`[data-analysis-message="${id}"]`);
export async function load(page: Page, mode: HostMode = "editable") {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	let url = "https://analysis-host.invalid/";
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
	expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
	expect(
		await page.evaluate(() => window.isSecureContext && typeof crypto.randomUUID === "function"),
	).toBe(true);
	await page.addStyleTag({ content: stylesheet });
	await page.addStyleTag({
		content: `
		body { margin:0; }
		.analysis-host-chat { display:flex; flex-direction:column; width:min(460px,calc(100vw - 48px)); height:500px; margin:24px; }
		.analysis-host-chat > [data-focus-boundary] { flex:1; min-height:0; overflow:auto; }
		.analysis-host-chat .chat-composer { height:80px; flex:none; }
		.analysis-host-chat [data-chat-stack] { display:flex; flex-direction:column; gap:16px; }
	`,
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(mode => window.analysisHostFixture.mount(mode), mode);
	await expect(message(page, "host-jobs")).toBeVisible();
	expect(errors).toEqual([]);
	return errors;
}
export async function inspect(page: Page, id: string) {
	let anchor = message(page, id);
	await anchor.scrollIntoViewIfNeeded();
	await anchor.getByRole("button", { name: /^Analysis for message:/ }).focus();
	await expect(analysis(page, id)).toBeVisible();
}
export async function openCorrection(page: Page) {
	let anchor = message(page, "host-review");
	await anchor.scrollIntoViewIfNeeded();
	await anchor.getByRole("button", { name: "Review 1 excerpt", exact: true }).click();
	let panel = analysis(page, "host-review");
	await expect(panel.getByRole("button", { name: "Add to card", exact: true })).toBeFocused();
	await panel.getByRole("button", { name: "Add to card", exact: true }).click();
	await expect(panel.getByRole("combobox", { name: "Contribution type", exact: true }))
		.toBeFocused();
	await panel.getByRole("combobox", { name: "Decision card", exact: true }).selectOption(
		"host-thread",
	);
	await panel.getByRole("textbox", { name: "Exact text", exact: true }).fill("encryption");
	return panel;
}
