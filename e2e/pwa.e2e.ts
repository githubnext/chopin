/**
 * The installable shell: a public manifest and icons, touch text fields that
 * never fall below the 16px that stops iOS zooming on focus, and floating
 * chrome that clears the top safe area.
 */

import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const SOURCE = `<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">

Body.

</Callout>

The rollout goes team by team, starting with the docs team.
`;

async function fontSize(page: Page, name: string): Promise<number> {
	return page.getByRole("textbox", { name, exact: true }).evaluate(element =>
		parseFloat(getComputedStyle(element).fontSize)
	);
}

test("the web app manifest and icons are public and installable", async ({ baseURL, browser }) => {
	let context = await browser.newContext({ baseURL });
	let page = await context.newPage();
	let manifest = await page.request.get("/manifest.webmanifest");
	expect(manifest.status()).toBe(200);
	expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
	let { icons } = await manifest.json() as { icons: { src: string }[] };
	for (let src of [...icons.map(icon => icon.src), "/icons/apple-touch-icon.png"]) {
		let icon = await page.request.get(src);
		expect(icon.status(), src).toBe(200);
		expect(icon.headers()["content-type"], src).toBe("image/png");
	}

	await page.goto("/");
	let cdp = await context.newCDPSession(page);
	let parsed = await cdp.send("Page.getAppManifest");
	expect(parsed.errors).toEqual([]);
	let { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
	expect(installabilityErrors).toEqual([]);
	await context.close();
});

test("touch text fields stay at least 16px while desktop keeps its sizes", async ({ join, seed }) => {
	await seed(SOURCE);
	let desktop = await join("ana", { viewport: { width: 1440, height: 900 } });
	expect(await fontSize(desktop, "Callout title")).toBeLessThan(16);

	let phone = await join("ana", PHONE);
	// Phones open documents for reading; fields appear once the writer edits.
	await phone.getByRole("button", { name: "Edit document" }).tap();
	expect(await fontSize(phone, "Callout title")).toBeGreaterThanOrEqual(16);
	await content(phone).locator("p").filter({ hasText: "The rollout" }).selectText();
	await phone.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let field = phone.getByRole("dialog", { name: "New comment" }).getByPlaceholder("Add a comment");
	await expect(field).toBeFocused();
	expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
		.toBeGreaterThanOrEqual(16);
});

test("the phone top bar's Documents button clears the top safe area", async ({ join }) => {
	let page = await join("ana", PHONE);
	let button = page.getByRole("button", { name: "Documents", exact: true });
	await expect(button).toBeVisible();
	let resting = (await button.boundingBox())!.y;
	// Newer than Playwright's protocol types; Chromium reports env(safe-area-inset-*) from it.
	let cdp = await page.context().newCDPSession(page) as unknown as {
		send(method: string, params: unknown): Promise<unknown>;
	};
	await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 59, bottom: 34 } });
	await expect.poll(async () => (await button.boundingBox())!.y).toBeCloseTo(resting + 59, 0);
});
