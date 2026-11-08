/**
 * What a pane resize drag asks of the page.
 *
 * What a person sees is the existing tests' business (the edge follows the pointer, the keyboard
 * steps, a taken-away drag puts the bar down). These pin the questions the page must not ask on
 * every step of a drag.
 */

import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

type Watch = { documentAnimations: number; chatEffects: number };

declare global {
	interface Window {
		__paneWatch: Watch;
	}
}

/** Count what a drag must not do, from before the page's own scripts run. */
async function watch(page: Page) {
	await page.addInitScript(() => {
		let log: Watch = { documentAnimations: 0, chatEffects: 0 };
		window.__paneWatch = log;
		// The page-wide scan for running animations, once asked on every layout change.
		let getAnimations = Document.prototype.getAnimations;
		Document.prototype.getAnimations = function() {
			log.documentAnimations++;
			return getAnimations.call(this);
		};
		// The Chat measurement effect looks for its cards with this selector on every run.
		let querySelectorAll = Element.prototype.querySelectorAll;
		Element.prototype.querySelectorAll = function(selector: string) {
			if (selector.includes("data-chat-placement")) log.chatEffects++;
			return querySelectorAll.call(this, selector);
		};
	});
}

function watched(page: Page): Promise<Watch> {
	return page.evaluate(() => structuredClone(window.__paneWatch));
}

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

test("a Projects sidebar resize follows the pointer without asking the page what is animating or measuring the Chat again", async ({ join, page }) => {
	await watch(page);
	await join("ana");
	let handle = page.getByRole("separator", { name: "Resize Projects sidebar" });
	let sidebar = page.locator(".project-sidebar-frame");
	await expect(handle).toBeVisible();
	let before = (await box(sidebar)).width;
	let opening = await watched(page);
	let start = await box(handle);

	await page.mouse.move(start.x + start.width / 2, start.y + 80);
	await page.mouse.down();
	await page.mouse.move(start.x + start.width / 2 + 60, start.y + 80, { steps: 10 });

	await expect.poll(async () => (await box(sidebar)).width).toBeCloseTo(before + 60, 0);
	// The workspace re-measures when the space beside the sidebar changes, and asks only about the
	// sidebar's own track while it does. Chat renders with it, and its offer cards have no reason to
	// be looked for again.
	let moving = await watched(page);
	expect(moving.documentAnimations).toBe(opening.documentAnimations);
	expect(moving.chatEffects).toBe(opening.chatEffects);

	await page.mouse.up();
});
