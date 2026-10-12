/**
 * A phone opening a document paints the workspace's shape from the first frame: the static
 * skeleton in index.html before any JavaScript, then the same shape until the document syncs.
 * The bars never move when the loaded chrome replaces them.
 */

import { authenticate, expect, ready, roomPath, test } from "./room";
import { RESPONSIVE_SOURCE } from "./responsive";

import type { BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 393, height: 852 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
	let value = await locator.boundingBox();
	expect(value).not.toBeNull();
	return value!;
}

function expectSameBox(actual: Box, expected: Box) {
	for (let key of ["x", "y", "width", "height"] as const) {
		expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(0.5);
	}
}

/** Holds every script until released, so the page shows only what index.html paints. */
async function holdScripts(context: BrowserContext): Promise<() => void> {
	let release!: () => void;
	let released = new Promise<void>(resolve => (release = resolve));
	await context.route(/\.(js|tsx?)(\?.*)?$/, async route => {
		await released;
		await route.continue();
	});
	return release;
}

async function open(
	browser: import("@playwright/test").Browser,
	baseURL: string,
	options: BrowserContextOptions,
): Promise<{ context: BrowserContext; page: Page }> {
	let context = await browser.newContext({ ...options, baseURL });
	let page = await context.newPage();
	await authenticate(page, "ana", baseURL);
	return { context, page };
}

for (
	let [name, device] of [
		["a phone", PHONE],
		["the narrowest phone", { ...PHONE, viewport: { width: 320, height: 568 } }],
	] as const
) {
	test(`${name} paints the workspace shape before its JavaScript and keeps the bars still`, async ({ baseURL, browser, room, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let { context, page } = await open(browser, baseURL!, device);
		try {
			let release = await holdScripts(context);
			await page.goto(roomPath(room), { waitUntil: "commit" });

			let skeleton = page.locator(".boot-skeleton .phone-skeleton");
			await expect(skeleton).toBeVisible();
			await expect(skeleton.locator(".phone-skeleton-heading")).toBeVisible();
			await expect(skeleton.getByRole("status")).toHaveText("Opening document…");
			let top = await box(skeleton.locator(".phone-skeleton-top"));
			let bar = await box(skeleton.locator(".phone-skeleton-bar"));
			let action = await box(skeleton.locator(".phone-skeleton-action"));
			let trigger = await box(skeleton.locator(".phone-skeleton-slot").first());
			expect(top.y).toBe(0);
			expect(top.height).toBe(44);
			expect(bar.height).toBe(62);
			expect(action.height).toBe(device.viewport.width < 360 ? 48 : 54);

			release();
			await ready(page);
			await expect(page.locator(".phone-skeleton")).toHaveCount(0);
			expectSameBox(await box(page.locator(".phone-top-bar")), top);
			expectSameBox(await box(page.locator(".phone-tab-bar")), bar);
			expectSameBox(await box(page.getByRole("button", { name: "Edit document" })), action);
			expectSameBox(
				await box(page.locator(".phone-top-bar").getByRole("button", { name: "Documents" })),
				trigger,
			);
		} finally {
			await context.close();
		}
	});
}

test("a phone keeps the skeleton in the document column until the document syncs", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let { context, page } = await open(browser, baseURL!, PHONE);
	try {
		let release!: () => void;
		let released = new Promise<void>(resolve => (release = resolve));
		await page.routeWebSocket(/\/ws(\?.*)?$/, async socket => {
			await released;
			socket.connectToServer();
		});
		await page.goto(roomPath(room), { waitUntil: "commit" });

		// The workspace has mounted, but its document has not arrived.
		let topBar = page.locator(".phone-top-bar");
		await expect(topBar).toBeVisible();
		let lines = page.locator("[data-plan-scroll] .plan-preface .phone-skeleton-page");
		await expect(lines).toBeVisible();
		let column = page.locator("[data-plan-scroll]").first();
		await expect(column).toHaveAttribute("aria-busy", "true");
		await expect(page.locator("[data-plan-scroll] > .mdxeditor")).toBeHidden();
		await expect(page.getByText("Propose investigation")).toBeHidden();
		// The bar's small title waits, as it does while the document's own heading shows.
		await expect(topBar.locator(".phone-top-bar-title")).toHaveCSS("opacity", "0");
		let top = await box(topBar);
		let bar = await box(page.locator(".phone-tab-bar"));

		release();
		await ready(page);
		await expect(lines).toHaveCount(0);
		await expect(column).not.toHaveAttribute("aria-busy", "true");
		await expect(page.locator(".plan-content h1").first()).toBeVisible();
		expectSameBox(await box(topBar), top);
		expectSameBox(await box(page.locator(".phone-tab-bar")), bar);
	} finally {
		await context.close();
	}
});

test("desktop never shows the phone skeleton", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let { context, page } = await open(browser, baseURL!, DESKTOP);
	try {
		let release = await holdScripts(context);
		await page.goto(roomPath(room), { waitUntil: "commit" });
		await expect(page.locator(".boot-skeleton")).toBeAttached();
		await expect(page.locator(".boot-skeleton .phone-skeleton")).toBeHidden();
		release();
		await ready(page);
		await expect(page.locator(".phone-skeleton")).toHaveCount(0);
	} finally {
		await context.close();
	}
});
