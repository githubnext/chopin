import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { terminalOriginBinding } from "./question-terminal-origin.fixture";
import type { Page } from "@playwright/test";

let script: string;
let stylesheet: string;

test.beforeAll(async () => {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let entry = fileURLToPath(
		new URL("../../packages/editor/src/widgets/questionnaire.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-question-terminal-origin-binding",
			setup(build) {
				build.onLoad({ filter: /\/widgets\/questionnaire\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + "\n" + terminalOriginBinding,
				}));
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
	let editor = files.filter(name => /^plan-editor-.*\.css$/.test(name));
	expect(names).toHaveLength(1);
	expect(editor).toHaveLength(1);
	stylesheet = (await Promise.all([names[0]!, editor[0]!].map(name =>
		readFile(assets + name, "utf8")
	))).join("\n");
	expect(stylesheet).toContain(".question-choice-row");
	expect(stylesheet).toContain(".choice-control");
});

async function load(page: Page, mode: "suggestion" | "discarded" | "cancelled" | "gallery") {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	let url = "https://question-terminal-origin.invalid/";
	await page.route(
		"**/*",
		route =>
			route.request().url() === url && route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body:
						'<!doctype html><html><body><main class="plan p-6"><div id="fixture"></div></main></body></html>',
				})
				: route.abort(),
	);
	await page.goto(url);
	expect(await page.evaluate(() => ({ mode: document.compatMode, secure: window.isSecureContext })))
		.toEqual({ mode: "CSS1Compat", secure: true });
	await page.addStyleTag({ content: stylesheet });
	await page.addScriptTag({ content: script });
	await page.evaluate(mode => window.terminalOriginFixture.mount(mode), mode);
	return errors;
}

test("a real human edit removes from chat until the suggestion lifecycle is cleared", async ({ page }) => {
	let errors = await load(page, "suggestion");
	let badge = page.getByText("from chat", { exact: true });
	await expect(badge).toBeVisible();
	await expect(page.getByRole("radio", { name: "GitHub Apps from chat", exact: true }))
		.toBeChecked();
	await expect(page.getByRole("radio", { name: /GitHub Apps/ })).toBeChecked();
	expect((await page.evaluate(() => window.terminalOriginFixture.snapshot())).choice).toBeNull();
	await page.getByRole("radio", { name: "Auth0", exact: true }).check();
	await expect(badge).toHaveCount(0);
	expect((await page.evaluate(() => window.terminalOriginFixture.snapshot())).choice).toBe("a");
	await page.evaluate(() => window.terminalOriginFixture.empty());
	await expect(page.getByRole("radio", { name: "Auth0", exact: true })).not.toBeChecked();
	await expect(badge).toHaveCount(0);
	await page.evaluate(() => window.terminalOriginFixture.suggestion(false));
	await expect(page.getByRole("radio", { name: "GitHub Apps", exact: true })).not.toBeChecked();
	await page.evaluate(() => window.terminalOriginFixture.suggestion(true));
	await expect(badge).toBeVisible();
	await expect(page.getByRole("radio", { name: /GitHub Apps/ })).toBeChecked();
	expect((await page.evaluate(() => window.terminalOriginFixture.snapshot())).choice).toBeNull();
	await page.getByRole("radio", { name: "Write a custom answer", exact: true }).check();
	await page.getByRole("textbox", { name: "Custom answer for Auth", exact: true }).fill(
		"Another approach",
	);
	await expect(badge).toHaveCount(0);
	expect(await page.evaluate(() => window.terminalOriginFixture.snapshot())).toMatchObject({
		mode: "custom",
		custom: "Another approach",
	});
	expect(errors).toEqual([]);
});

test("the actual metadata-driven card shows Discarded rather than a stale answer or Cancelled", async ({ page }) => {
	let errors = await load(page, "discarded");
	await expect(
		page.getByText("Discarded by @bea — What auth system should we use?", { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/What auth system should we use\?/)).toBeVisible();
	await expect(page.getByText(/Cancelled|Answered by|GitHub Apps/)).toHaveCount(0);
	await expect(page.getByRole("radio")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("genuine cancellation remains separate in the styled real component gallery", async ({ page }) => {
	let errors = await load(page, "gallery");
	await expect(page.getByText("Cancelled by @ana", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Discarded by @bea — What auth system should we use?", { exact: true }),
	).toBeVisible();
	let badge = page.getByText("from chat", { exact: true });
	await expect(badge).toBeVisible();
	expect(
		await badge.evaluate(element => {
			let label = element.previousElementSibling;
			if (!label) throw new Error("Suggestion badge has no option label");
			let badgeStyle = getComputedStyle(element);
			let labelStyle = getComputedStyle(label);
			return {
				sameTextRole: badgeStyle.fontSize === labelStyle.fontSize,
				muted: badgeStyle.color !== labelStyle.color,
			};
		}),
	).toEqual({ sameTextRole: true, muted: true });
	await page.screenshot({ path: "/tmp/jev-question-terminal-origin.png", fullPage: true });
	expect(errors).toEqual([]);
});
