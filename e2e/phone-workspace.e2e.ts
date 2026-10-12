import { expect, openIsolatedRoom, test } from "./room";
import { expectNoHorizontalOverflow, RESPONSIVE_SOURCE } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function topBar(page: Page) {
	return page.locator(".phone-top-bar");
}

/** Scroll a pane and let its scroll event land before the next step. */
async function scrollPane(scroller: Locator, top: number): Promise<void> {
	await scroller.evaluate(async (element, value) => {
		element.scrollTo({ top: value });
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	}, top);
}

async function topOffset(page: Page): Promise<number> {
	return topBar(page).evaluate(element => element.getBoundingClientRect().top);
}

test("a phone gets full-bleed panes under a top bar and a bottom tab bar", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	let root = page.locator(".workspace-root");
	await expect(root).toHaveAttribute("data-workspace-phone");
	await expect(root).toHaveAttribute("data-workspace-mode", "compact");
	await expect(page.locator(".phone-tab-row")).toBeVisible();

	let frame = await page.locator(".workspace-frame").evaluate(element => {
		let bounds = element.getBoundingClientRect();
		return {
			left: bounds.left,
			right: innerWidth - bounds.right,
			radius: getComputedStyle(element).borderRadius,
		};
	});
	expect(frame).toEqual({ left: 0, right: 0, radius: "0px" });

	// The sidebar trigger lives in the bar, so it is the only one.
	await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveCount(0);
	await expect(topBar(page).getByRole("button", { name: "Documents", exact: true })).toBeVisible();
	await expect(topBar(page).getByRole("button", { name: /^Actions for / })).toBeVisible();
	for (let control of await topBar(page).getByRole("button").all()) {
		let box = await control.boundingBox();
		expect(box!.height).toBeGreaterThanOrEqual(44);
		expect(box!.width).toBeGreaterThanOrEqual(44);
	}
	await expectNoHorizontalOverflow(page);
});

test("the phone tab bar switches destinations in one bar and returns a tab to its top", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let tabs = nav.getByRole("button");
	await expect(tabs).toHaveCount(4);
	await expect(tabs.nth(0)).toHaveAccessibleName(/^Chat/);
	await expect(tabs.nth(1)).toHaveAccessibleName("Document");
	await expect(tabs.nth(2)).toHaveAccessibleName(/^Decisions/);
	await expect(tabs.nth(3)).toHaveAccessibleName("Build");
	await expect(tabs.nth(1)).toHaveAttribute("aria-current", "page");
	for (let tab of await tabs.all()) {
		let box = (await tab.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}

	let scroller = page.locator("[data-plan-scroll]");
	await scrollPane(scroller, 300);
	await scrollPane(scroller, 700);
	// Reading down minimised the bar to the current tab; a tap brings the tabs back.
	await nav.getByRole("button", { name: /^Show tabs/ }).click();
	await tabs.nth(0).click();
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(tabs.nth(0)).toHaveAttribute("aria-current", "page");
	await tabs.nth(2).click();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	await tabs.nth(3).click();
	await expect(page.getByRole("region", { name: "Build", exact: true })).toBeVisible();
	await tabs.nth(1).click();
	await expect(page.locator('[data-document-view="plan"]')).toBeVisible();
	// Each pane keeps its place, and tapping the current tab again goes back to the top.
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(700);
	await tabs.nth(1).click();
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
});

test("a landscape phone keeps the compact phone layout", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { ...PHONE, viewport: { width: 734, height: 343 } });
	let root = page.locator(".workspace-root");
	await expect(root).toHaveAttribute("data-workspace-phone");
	await expect(root).toHaveAttribute("data-workspace-mode", "compact");
	await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
	await expect(page.locator(".phone-tab-row")).toBeVisible();
	// Landscape chrome stays low: a short top bar and a one-line tab bar.
	let [bar, tabs] = await Promise.all([
		topBar(page).boundingBox(),
		page.getByRole("navigation", { name: "Workspace view" }).boundingBox(),
	]);
	expect(bar!.height + tabs!.height).toBeLessThanOrEqual(90);
	for (
		let tab of await page.getByRole("navigation", { name: "Workspace view" }).getByRole("button")
			.all()
	) {
		expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	}
});

test("the top bar hides while reading down and returns on scroll up", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	let scroller = page.locator("[data-plan-scroll]");
	await expect(topBar(page)).toBeVisible();
	expect(await topOffset(page)).toBe(0);
	// The small title waits for the document's own heading to scroll away.
	let title = topBar(page).locator(".phone-top-bar-title");
	await expect(title).toHaveCSS("opacity", "0");

	await scrollPane(scroller, 200);
	await scrollPane(scroller, 600);
	await expect(page.locator(".workspace-root")).toHaveAttribute("data-workspace-bar", "hidden");
	await expect.poll(() => topOffset(page)).toBeLessThan(-40);
	await expect(title).toHaveCSS("opacity", "1");

	await scrollPane(scroller, 500);
	await expect(page.locator(".workspace-root")).not.toHaveAttribute("data-workspace-bar", "hidden");
	await expect.poll(() => topOffset(page)).toBe(0);

	// Focus moving into a hidden bar brings it back.
	await scrollPane(scroller, 900);
	await expect(page.locator(".workspace-root")).toHaveAttribute("data-workspace-bar", "hidden");
	await topBar(page).getByRole("button", { name: /^Actions for / }).focus();
	await expect(page.locator(".workspace-root")).not.toHaveAttribute("data-workspace-bar", "hidden");
	await page.keyboard.press("Escape");

	// Reduced motion never hides it.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await scrollPane(scroller, 1200);
	await scrollPane(scroller, 1600);
	await expect(page.locator(".workspace-root")).not.toHaveAttribute("data-workspace-bar", "hidden");
});

/** Space between the current tab's label and its pill's rounded edge, at the label's lower part. */
async function labelClearance(page: Page): Promise<number> {
	return page.locator(".phone-tab-bar").evaluate(bar => {
		let pill = bar.querySelector(".phone-tab-indicator")!;
		let bounds = pill.getBoundingClientRect();
		let label = document.createRange();
		label.selectNodeContents(
			bar.querySelector('.phone-tab[aria-current="page"] .phone-tab-label')!,
		);
		let text = label.getBoundingClientRect();
		let radius = Math.min(
			bounds.height / 2,
			parseFloat(getComputedStyle(pill).borderTopLeftRadius),
		);
		let rise = Math.max(0, text.bottom - text.height * 0.2 - (bounds.bottom - radius));
		let curve = radius - Math.sqrt(Math.max(0, radius * radius - rise * rise));
		return Math.min(text.left - bounds.left, bounds.right - text.right) - curve;
	});
}

test("the tab bar's pill is concentric with the bar and clears even its widest label at 320", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { ...PHONE, viewport: { width: 320, height: 568 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	// Document has the widest label, so it is the tightest fit.
	await expect(nav.getByRole("button", { name: "Document" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect.poll(() => labelClearance(page)).toBeGreaterThanOrEqual(3);
	await nav.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	for (
		let control of [
			...await nav.getByRole("button").all(),
			page.getByRole("button", { name: "Edit document" }),
		]
	) {
		let box = (await control.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await expect.poll(() => labelClearance(page)).toBeGreaterThanOrEqual(3);
	let corners = await page.locator(".phone-tab-bar").evaluate(bar => {
		let pill = bar.querySelector(".phone-tab-indicator")!;
		return {
			bar: parseFloat(getComputedStyle(bar).borderTopLeftRadius),
			inset: pill.getBoundingClientRect().top - bar.getBoundingClientRect().top,
			pill: parseFloat(getComputedStyle(pill).borderTopLeftRadius),
		};
	});
	expect(corners.pill).toBeCloseTo(corners.bar - corners.inset, 1);
	await expectNoHorizontalOverflow(page);
});

test("the tab bar minimises while reading down and returns on scroll up, a tap or focus", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	let scroller = page.locator("[data-plan-scroll]");
	let row = page.locator("[data-phone-tab-row]");
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let show = nav.getByRole("button", { name: /^Show tabs/ });
	let width = () => nav.evaluate(element => element.getBoundingClientRect().width);
	await expect(show).toHaveCount(0);
	let full = await width();

	await scrollPane(scroller, 200);
	await scrollPane(scroller, 600);
	await expect(row).toHaveAttribute("data-phone-tab-minimised", "");
	// The top bar tucks away on the same scroll.
	await expect(page.locator(".workspace-root")).toHaveAttribute("data-workspace-bar", "hidden");
	await expect(show).toHaveAccessibleName("Show tabs, Document");
	await expect(nav.getByRole("button")).toHaveCount(1);
	await expect.poll(width).toBeLessThan(60);
	let circle = (await show.boundingBox())!;
	expect(circle.width).toBeGreaterThanOrEqual(44);
	expect(circle.height).toBeGreaterThanOrEqual(44);

	await scrollPane(scroller, 500);
	await expect(row).not.toHaveAttribute("data-phone-tab-minimised");
	await expect.poll(width).toBeCloseTo(full, 0);

	await scrollPane(scroller, 900);
	await expect(row).toHaveAttribute("data-phone-tab-minimised", "");
	await show.click();
	await expect(row).not.toHaveAttribute("data-phone-tab-minimised");
	await expect(page.locator(".workspace-root")).not.toHaveAttribute("data-workspace-bar", "hidden");
	await expect(nav.getByRole("button", { name: "Document" })).toBeFocused();

	// A slow drag of a few pixels a frame still adds up to a reading direction, both ways.
	for (let top = 903; top <= 960; top += 3) await scrollPane(scroller, top);
	await expect(row).toHaveAttribute("data-phone-tab-minimised", "");
	await expect(page.locator(".workspace-root")).toHaveAttribute("data-workspace-bar", "hidden");
	for (let top = 957; top >= 900; top -= 3) await scrollPane(scroller, top);
	await expect(row).not.toHaveAttribute("data-phone-tab-minimised");
	await expect(page.locator(".workspace-root")).not.toHaveAttribute("data-workspace-bar", "hidden");

	// Keyboard focus reaching the circle restores the tabs and lands on the current one.
	await scrollPane(scroller, 1300);
	await expect(row).toHaveAttribute("data-phone-tab-minimised", "");
	await show.focus();
	await expect(row).not.toHaveAttribute("data-phone-tab-minimised");
	await expect(nav.getByRole("button", { name: "Document" })).toBeFocused();
});

test("reduced motion keeps the full tab bar while reading", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	await page.emulateMedia({ reducedMotion: "reduce" });
	let scroller = page.locator("[data-plan-scroll]");
	await scrollPane(scroller, 200);
	await scrollPane(scroller, 600);
	await scrollPane(scroller, 1000);
	await expect(page.locator("[data-phone-tab-row]")).not.toHaveAttribute(
		"data-phone-tab-minimised",
	);
	await expect(page.getByRole("navigation", { name: "Workspace view" }).getByRole("button"))
		.toHaveCount(4);
});

test("the software keyboard hides the bottom chrome", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let { close, page } = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"ana",
		PHONE,
		context =>
			installVisualViewport(context, {
				height: 844,
				offsetLeft: 0,
				offsetTop: 0,
				pageLeft: 0,
				pageTop: 0,
				scale: 1,
				width: 390,
			}),
	);
	try {
		let row = page.locator(".phone-tab-row");
		await expect(row).toBeVisible();
		await setVisualViewport(page, { event: "resize", height: 500 });
		await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", "");
		await expect(row).toBeHidden();
		await setVisualViewport(page, { event: "resize", height: 844 });
		await expect(row).toBeVisible();
	} finally {
		await close();
	}
});

test("desktop and touch tablets keep their layouts", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let desktop = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(desktop.locator(".workspace-root")).not.toHaveAttribute("data-workspace-phone");
	await expect(desktop.locator(".phone-tab-row")).toHaveCount(0);
	await desktop.context().close();

	let tablet = await join("ana", { hasTouch: true, viewport: { width: 820, height: 1180 } });
	await expect(tablet.locator(".workspace-root")).not.toHaveAttribute("data-workspace-phone");
	await expect(tablet.locator(".phone-tab-row")).toHaveCount(0);
});
