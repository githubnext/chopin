import { expect } from "@playwright/test";

import { fixtureSource } from "./excerpt-correction.fixture";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import type { Mode } from "./excerpt-correction.fixture";

let script: string;

export async function prepareForm(): Promise<void> {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let result = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("../../apps/web/src/conversation-plan/excerpt-correction.tsx", import.meta.url),
			),
		],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "excerpt-correction-test-binding",
			setup(build) {
				build.onLoad({ filter: /\/excerpt-correction\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + fixtureSource,
				}));
			},
		}],
	});
	expect(result.success).toBe(true);
	expect(result.outputs).toHaveLength(1);
	script = await result.outputs[0]!.text();
}

export async function loadForm(page: Page, mode: Mode = "editable"): Promise<void> {
	let fixtureUrl = "https://excerpt-correction.invalid/";
	await page.route("**/*", route => {
		if (route.request().url() === fixtureUrl && route.request().isNavigationRequest()) {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: '<main><div id="fixture"></div></main>',
			});
		}
		return route.abort();
	});
	await page.goto(fixtureUrl);
	expect(
		await page.evaluate(() => ({
			secure: window.isSecureContext,
			uuid: typeof window.crypto.randomUUID,
		})),
	).toEqual({ secure: true, uuid: "function" });
	await page.addScriptTag({ content: script });
	await page.evaluate(mode => window.analysisFixture.mount(mode), mode);
	await expect(page.getByRole("button", { name: "Add to card", exact: true })).toBeVisible();
}

export async function openForm(page: Page): Promise<void> {
	await loadForm(page);
	await page.getByRole("button", { name: "Add to card", exact: true }).click();
	await page.getByRole("combobox", { name: "Decision card", exact: true }).selectOption("thread-1");
}
