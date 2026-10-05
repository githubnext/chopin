import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { researchOffersFixture } from "./research-offers.fixture";

declare global {
	interface Window {
		researchOffersProbe: {
			hold(): void;
			release(): void;
			move(): void;
			remote(text: string): void;
			capabilities(canAct: boolean, canExecute: boolean): void;
			snapshot(): { brief: string; started: string[]; requests: string[]; pending: number };
		};
		researchInput?: HTMLTextAreaElement;
	}
}
let script = "", stylesheet = "";
test.beforeAll(async () => {
	let entry = fileURLToPath(new URL("../../apps/web/src/chat/transcript.tsx", import.meta.url));
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "research-offer-browser-fixture",
			setup(build) {
				build.onLoad(
					{ filter: /\/chat\/transcript\.tsx$/ },
					async args => ({
						loader: "tsx",
						contents: await Bun.file(args.path).text() + "\n" + researchOffersFixture,
					}),
				);
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	script = await result.outputs.find(item => item.path.endsWith(".js"))!.text();
	let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
	let css = (await readdir(assets)).filter(name => /^index-.*\.css$/.test(name));
	stylesheet = (await Promise.all(css.map(name => readFile(assets + name, "utf8")))).join("\n");
});
async function load(page: Page) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.route(
		"**/*",
		route =>
			route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body: '<!doctype html><div id="fixture"></div>',
				})
				: route.abort(),
	);
	await page.goto("https://research-offers.invalid/");
	await page.addStyleTag({
		content: stylesheet
			+ "\n#fixture{display:flex;gap:24px}section[aria-label=ana],section[aria-label=bo]{width:450px;height:650px}",
	});
	await page.addScriptTag({ content: script });
	await expect(page.getByRole("group", { name: "Research suggestion" })).toHaveCount(2);
	return errors;
}

test("two live editors merge concurrent input and Start waits for acknowledged text", async ({ page }) => {
	let errors = await load(page);
	let ana = page.getByRole("region", { name: "ana", exact: true });
	let bo = page.getByRole("region", { name: "bo", exact: true });
	await ana.getByRole("button", { name: "Edit brief", exact: true }).click();
	await bo.getByRole("button", { name: "Edit brief", exact: true }).click();
	await page.evaluate(() => window.researchOffersProbe.hold());
	await ana.getByRole("textbox", { name: "Research brief" }).fill(
		"Investigate fast Jev alternatives.",
	);
	await bo.getByRole("textbox", { name: "Research brief" }).fill(
		"Investigate Jev alternatives and costs.",
	);
	await expect.poll(() => page.evaluate(() => window.researchOffersProbe.snapshot().pending)).toBe(
		2,
	);
	await ana.getByRole("button", { name: "Start research", exact: true }).click();
	expect(await page.evaluate(() => window.researchOffersProbe.snapshot().started)).toEqual([]);
	await page.evaluate(() => window.researchOffersProbe.release());
	await expect.poll(() => page.evaluate(() => window.researchOffersProbe.snapshot().started))
		.toEqual(["Investigate fast Jev alternatives and costs."]);
	await expect(page.getByRole("textbox", { name: "Research brief" })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("moving an active card preserves its editor, focus and selection", async ({ page }) => {
	let errors = await load(page);
	let ana = page.getByRole("region", { name: "ana", exact: true });
	await ana.getByRole("button", { name: "Edit brief", exact: true }).click();
	let field = ana.getByRole("textbox", { name: "Research brief" });
	await field.evaluate(element => {
		let input = element as HTMLTextAreaElement;
		window.researchInput = input;
		input.focus();
		input.setSelectionRange(12, 15);
	});
	await page.evaluate(() => window.researchOffersProbe.move());
	await expect(field).toBeFocused();
	expect(
		await field.evaluate(element => ({
			same: element === window.researchInput,
			start: (element as HTMLTextAreaElement).selectionStart,
			end: (element as HTMLTextAreaElement).selectionEnd,
		})),
	).toEqual({ same: true, start: 12, end: 15 });
	expect(
		await ana.locator("[data-chat-stack]").evaluate(element =>
			[...element.children].findIndex(child => child.hasAttribute("data-research-offer"))
		),
	).toBe(3);
	expect(errors).toEqual([]);
});

test("fallback offers remain editable while research execution is disabled", async ({ page }) => {
	let errors = await load(page);
	await page.evaluate(() => window.researchOffersProbe.capabilities(true, false));
	let ana = page.getByRole("region", { name: "ana", exact: true });
	await expect(ana.getByRole("button", { name: "Start research", exact: true })).toBeDisabled();
	await expect(ana.getByRole("button", { name: "Edit brief", exact: true })).toBeEnabled();
	await page.evaluate(() => window.researchOffersProbe.capabilities(false, false));
	await expect(ana.getByRole("button", { name: "Edit brief", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("IME input merges remote edits while its card moves", async ({ page }) => {
	let errors = await load(page);
	let ana = page.getByRole("region", { name: "ana", exact: true });
	await ana.getByRole("button", { name: "Edit brief", exact: true }).click();
	let field = ana.getByRole("textbox", { name: "Research brief" });
	await field.evaluate(element => {
		let input = element as HTMLTextAreaElement;
		input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
			input,
			input.value + " 日本語",
		);
		input.dispatchEvent(
			new InputEvent("input", { bubbles: true, isComposing: true, data: "日本語" }),
		);
	});
	await page.evaluate(() => {
		window.researchOffersProbe.remote("Investigate fast Jev alternatives.");
		window.researchOffersProbe.move();
	});
	await field.evaluate(element =>
		element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }))
	);
	await expect(field).toHaveValue("Investigate fast Jev alternatives. 日本語");
	await expect.poll(() => page.evaluate(() => window.researchOffersProbe.snapshot().brief)).toBe(
		"Investigate fast Jev alternatives. 日本語",
	);
	expect(errors).toEqual([]);
});
