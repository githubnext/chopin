/**
 * Reading on a phone: documents open as a reader holds them, the pencil switches to editing, and
 * editing-only chrome stays out of a reader's way. Desktop and viewers are unchanged.
 */

import { createChannel } from "./database";
import { authenticate, content, edit, expect, openIsolatedRoom, roomPath, test } from "./room";
import { RESPONSIVE_SOURCE } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { BrowserContext, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PROSE = "Members lose edits when the train goes into a tunnel.";
const SOURCE = `${PROSE} See the [Yjs docs](https://example.com/yjs).

Second paragraph for the caret.
`;

function pencil(page: Page) {
	return page.getByRole("button", { name: "Edit document" });
}

function done(page: Page) {
	return page.getByRole("button", { name: "Done editing" });
}

async function fakeKeyboard(context: BrowserContext) {
	await installVisualViewport(context, {
		height: 844,
		offsetLeft: 0,
		offsetTop: 0,
		pageLeft: 0,
		pageTop: 0,
		scale: 1,
		width: 390,
	});
}

test("a phone opens a document for reading", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(pencil(page)).toBeVisible();
	let box = await pencil(page).boundingBox();
	expect(box!.width).toBeGreaterThanOrEqual(44);

	// Tapping prose places no caret, so no keyboard comes up.
	await page.getByText("Second paragraph").tap();
	expect(
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.isContentEditable),
	)
		.toBe(false);

	// A reader's selection can still be commented on, and offers no formatting.
	await page.getByText("Second paragraph").evaluate(element => {
		let text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
		let range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 6);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(range);
	});
	await expect(page.getByRole("button", { name: "Comment on this passage" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Bold" })).toHaveCount(0);
});

test("a reader's tap follows a link instead of previewing it", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ body: "<title>Yjs</title>", contentType: "text/html" }),
	);
	let opened = page.context().waitForEvent("page");
	await page.getByRole("link", { name: "Yjs docs" }).tap();
	expect((await opened).url()).toBe("https://example.com/yjs");
	await expect(page.getByRole("button", { name: /^Open/ })).toHaveCount(0);
});

test("an in-app link navigates within Chopin", async ({ baseURL, join, room, seed }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	await seed(`Read [the other document](${roomPath(other)}) next.\n`);
	let page = await join("ana", PHONE);
	await page.getByRole("link", { name: "the other document" }).tap();
	await expect(page).toHaveURL(new RegExp(`${roomPath(other)}$`));
	await expect(page).not.toHaveURL(new RegExp(`${roomPath(room)}$`));
});

test("the pencil edits where the reader tapped and Done returns to reading", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	let writer = await join("bo", { viewport: { width: 1440, height: 900 } });

	await page.getByText("Second paragraph").tap();
	await pencil(page).tap();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	await expect(content(page)).toBeFocused();
	await expect(done(page)).toBeVisible();
	await page.keyboard.type("Typed ");
	await expect(content(page)).toContainText("Typed ");
	await expect(writer.getByText(/Typed /)).toBeVisible();

	// Editing survives a trip to another tab.
	let tabs = page.getByRole("navigation", { name: "Workspace view" });
	await tabs.getByRole("button", { name: /^Chat/ }).tap();
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await tabs.getByRole("button", { name: "Document", exact: true }).tap();
	await expect(done(page)).toBeVisible();

	await done(page).tap();
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(pencil(page)).toBeVisible();
	expect(
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.isContentEditable),
	)
		.toBeFalsy();

	// Someone else's edits keep arriving while reading.
	await content(writer).click();
	await writer.keyboard.press("ControlOrMeta+End");
	await writer.keyboard.type(" Remote words.");
	await expect(content(page)).toContainText("Remote words.");
});

test("formatting docks above the keyboard while editing", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE, fakeKeyboard);
	try {
		await page.getByText("Second paragraph").tap();
		await pencil(page).tap();
		await setVisualViewport(page, { event: "resize", height: 500 });
		let dock = page.getByRole("toolbar", { name: "Formatting" });
		await expect(dock).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeHidden();
		await expect(done(page)).toBeVisible();
		// Layout size, not the box: the dock rises in with a brief scale.
		for (let control of await dock.getByRole("button").all()) {
			let size = await control.evaluate(element => {
				let html = element as HTMLElement;
				return Math.min(html.offsetWidth, html.offsetHeight);
			});
			expect(size).toBeGreaterThanOrEqual(44);
		}
		let bottom = await dock.evaluate(element => element.getBoundingClientRect().bottom);
		expect(bottom).toBeLessThanOrEqual(500);

		await dock.getByRole("button", { name: "Bold" }).tap();
		await page.keyboard.type("loud");
		await expect(content(page).locator("strong, b").filter({ hasText: "loud" })).toHaveCount(1);
		await expect(content(page)).toBeFocused();
		// One formatting surface at a time.
		await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);

		await dock.getByRole("button", { name: "Hide keyboard" }).tap();
		await expect(content(page)).not.toBeFocused();
		await setVisualViewport(page, { event: "resize", height: 844 });
		await expect(dock).toHaveCount(0);
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	} finally {
		await close();
	}
});

test("reading hides editing-only chrome that editing brings back", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", PHONE);
	let editing = [
		page.getByRole("button", { name: "Show source" }),
		page.getByRole("button", { name: /^Code language:/ }),
		page.getByRole("button", { name: "Edit image" }),
		page.getByRole("button", { name: "Add tab" }),
		page.getByRole("button", { name: /^Remove / }),
	];
	for (let control of editing) await expect(control).toHaveCount(0);
	// The language still reads as a label.
	await expect(content(page).getByText("TypeScript", { exact: true }).first()).toBeAttached();

	await edit(page);
	await expect(page.getByRole("button", { name: "Show source" }).first()).toBeAttached();
	await expect(page.getByRole("button", { name: "Add tab" }).first()).toBeAttached();
});

test("viewers get no pencil and desktop stays editable", async ({ baseURL, browser, join, room, seed }) => {
	await seed(SOURCE);
	let desktop = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(content(desktop)).toHaveAttribute("contenteditable", "true");
	await expect(pencil(desktop)).toHaveCount(0);

	let context = await browser.newContext({ ...PHONE, baseURL });
	try {
		let viewer = await context.newPage();
		await authenticate(viewer, "readonly", baseURL!);
		await viewer.goto(roomPath(room));
		await expect(viewer.locator("[data-plan-synced]")).toBeAttached({ timeout: 20_000 });
		await expect(content(viewer)).toHaveAttribute("contenteditable", "false");
		await expect(viewer.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
		await expect(pencil(viewer)).toHaveCount(0);
		await expect(done(viewer)).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("an empty document opens ready to write", async ({ join }) => {
	let page = await join("ana", PHONE);
	await expect(done(page)).toBeVisible();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
});
