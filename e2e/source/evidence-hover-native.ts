import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { evidenceFixtureSource } from "./evidence-hover.fixture";

import type { Page } from "@playwright/test";

let script: string;
let stylesheet: string;

export async function prepareEvidence(): Promise<void> {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let entry = fileURLToPath(new URL("../../apps/web/src/chat/transcript.tsx", import.meta.url));
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "evidence-hover-test-binding",
			setup(build) {
				build.onLoad({ filter: /\/chat\/transcript\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + "\n" + evidenceFixtureSource,
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
}

export let panelName = "Evidence for What auth system should we use?";
export let card = (page: Page) =>
	page.locator('article[data-plan-sidecar-questionnaire="native-evidence-card"]');
export let panel = (page: Page) => page.getByRole("dialog", { name: panelName, exact: true });
export let source = (page: Page) =>
	panel(page).getByRole("button", {
		name: "Show “People already have GitHub accounts.” in chat",
		exact: true,
	}).first();

export async function load(page: Page, editable = false): Promise<void> {
	let fixtureUrl = "https://evidence-hover.invalid/";
	await page.route("**/*", route => {
		if (route.request().url() === fixtureUrl && route.request().isNavigationRequest()) {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: '<div id="fixture"></div>',
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
	await page.addStyleTag({ content: stylesheet });
	// Isolated host dimensions only; card, panel, controls and Transcript are actual components.
	await page.addStyleTag({
		content: `
		body { margin:0; }
		main { display:flex; gap:24px; padding:24px; }
		.plan-document { width:340px; flex:none; }
		[data-plan-scroll] { height:320px; overflow:auto; }
		.native-chat { width:380px; }
		.native-chat [data-focus-boundary] { height:320px; overflow:auto; }
		.native-chat [data-chat-stack] { display:flex; flex-direction:column; gap:18px; }
	`,
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(editable => window.evidenceFixture.mount(editable), editable);
	await expect(card(page)).toBeVisible();
}
export async function open(page: Page) {
	await card(page).getByRole("button", { name: "Inspect decision evidence", exact: true }).click();
	await expect(panel(page)).toBeVisible();
}
export async function moveAway(page: Page) {
	await page.mouse.move(1, 1);
}
