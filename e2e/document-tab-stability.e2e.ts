import { content, expect, test } from "./room";
import { RESPONSIVE_SOURCE } from "./responsive";

import type { Page } from "@playwright/test";

async function expectTabInsideStrip(tab: ReturnType<Page["getByRole"]>) {
	await expect.poll(() =>
		tab.evaluate(node => {
			let strip = node.closest('[role="tablist"]')!.getBoundingClientRect();
			let box = node.getBoundingClientRect();
			return box.left >= strip.left - 1 && box.right <= strip.right + 1;
		})
	).toBe(true);
}

async function selectLastTab(tabs: ReturnType<Page["getByRole"]>) {
	await tabs.first().focus();
	await tabs.first().press("End");
	let last = tabs.last();
	await expect(last).toHaveAttribute("aria-selected", "true");
	await expect(last).toBeFocused();
	await expectTabInsideStrip(last);
}

test("a selected tab follows strip layout changes without moving the document", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("resized-tab-reader", { viewport: { width: 390, height: 844 } });
	let scroller = page.locator("[data-plan-scroll]");
	let tabs = content(page).getByRole("tablist").getByRole("tab");
	await selectLastTab(tabs);
	let initialViewport = await scroller.evaluate(node => {
		node.style.overflowAnchor = "none";
		let strip = node.querySelector<HTMLElement>('[role="tablist"]');
		if (!strip) throw new Error("tab strip must be rendered inside the document scroller");
		let scrollerBox = node.getBoundingClientRect();
		let stripBox = strip.getBoundingClientRect();
		let stripContentTop = stripBox.top - scrollerBox.top + node.scrollTop;
		node.scrollTop = Math.round(stripContentTop - (node.clientHeight - stripBox.height) / 2);
		let viewport = node.getBoundingClientRect();
		let visibleStrip = strip.getBoundingClientRect();
		return {
			scrollTop: node.scrollTop,
			maxScrollTop: node.scrollHeight - node.clientHeight,
			gapAbove: visibleStrip.top - viewport.top,
			gapBelow: viewport.bottom - visibleStrip.bottom,
			intersects: visibleStrip.top < viewport.bottom && visibleStrip.bottom > viewport.top,
		};
	});
	let documentScrollTop = initialViewport.scrollTop;
	expect(documentScrollTop).toBeGreaterThan(0);
	expect(initialViewport.maxScrollTop - documentScrollTop).toBeGreaterThan(0);
	expect(initialViewport.intersects).toBe(true);
	expect(initialViewport.gapAbove).toBeGreaterThan(0);
	expect(initialViewport.gapBelow).toBeGreaterThan(0);
	let expectStripInScrollerViewport = async () => {
		let visibility = await scroller.evaluate(node => {
			let strip = node.querySelector<HTMLElement>('[role="tablist"]');
			if (!strip) return false;
			let viewport = node.getBoundingClientRect();
			let visibleStrip = strip.getBoundingClientRect();
			return visibleStrip.top < viewport.bottom && visibleStrip.bottom > viewport.top;
		});
		expect(visibility).toBe(true);
	};
	await tabs.first().evaluate(node => {
		node.textContent = "A preceding collaborative tab label that became dramatically wider";
	});
	await expectTabInsideStrip(tabs.last());
	await expectStripInScrollerViewport();
	expect(await scroller.evaluate(node => node.scrollTop)).toBe(documentScrollTop);
	await page.setViewportSize({ width: 320, height: 844 });
	await expectTabInsideStrip(tabs.last());
	await expectStripInScrollerViewport();
	expect(await scroller.evaluate(node => node.scrollTop)).toBe(documentScrollTop);
});
