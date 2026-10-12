/**
 * Reading on a phone: documents open as a reader holds them, the pencil switches to editing, and
 * editing-only chrome stays out of a reader's way. Desktop and viewers are unchanged.
 */

import { chatInput } from "./chat-input";
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
	// The phone's docked selection bar, not the editing bubble.
	let bar = page.getByRole("toolbar", { name: "Selection actions" });
	await expect(bar.getByRole("button", { name: "Comment on this passage" })).toBeVisible();
	await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
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
	// A heading, so the top bar's small title waits at the top of the document.
	await seed(`# Field notes\n\n${SOURCE}`);
	let page = await join("ana", PHONE);
	let writer = await join("bo", { viewport: { width: 1440, height: 900 } });

	await page.getByText("Second paragraph").tap();
	await pencil(page).tap();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	await expect(content(page)).toBeFocused();
	await expect(done(page)).toBeVisible();
	// At the top of the document the small title waits, but the mode still shows.
	await expect(page.locator(".phone-top-bar-mode")).toHaveText("Editing");
	await expect(page.locator(".phone-top-bar-mode")).toHaveCSS("opacity", "1");
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
		// One bar across the top of the keyboard, edge to edge, with Done at its trailing end.
		let row = page.locator("[data-phone-tab-row]");
		await row.evaluate(element =>
			Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
		);
		let bar = (await row.boundingBox())!;
		expect(bar.x).toBe(0);
		expect(bar.width).toBe(390);
		expect(Math.round(bar.y + bar.height)).toBe(500);
		let doneBox = (await done(page).boundingBox())!;
		expect(doneBox.x + doneBox.width).toBeGreaterThan(390 - 12);
		expect(doneBox.y).toBeGreaterThanOrEqual(bar.y);
		// Layout size, not the box.
		for (let control of await row.getByRole("button").all()) {
			let size = await control.evaluate(element => {
				let html = element as HTMLElement;
				return Math.min(html.offsetWidth, html.offsetHeight);
			});
			expect(size).toBeGreaterThanOrEqual(44);
		}

		// A caret gets blocks, styles and history.
		for (let name of ["Insert block", "Text style", "Undo", "Redo", "Hide keyboard"]) {
			await expect(dock.getByRole("button", { name, exact: true })).toBeVisible();
		}
		await expect(dock.getByRole("button", { name: "Bold" })).toHaveCount(0);

		await page.keyboard.type("loud ");
		await page.keyboard.press("ArrowLeft");
		for (let step = 0; step < 4; step++) await page.keyboard.press("Shift+ArrowLeft");
		// A selection gets marks, a link and a comment instead.
		for (
			let name of [
				"Bold",
				"Italic",
				"Strikethrough",
				"Inline code",
				"Link",
				"Comment on this passage",
				"Hide keyboard",
			]
		) {
			await expect(dock.getByRole("button", { name, exact: true })).toBeVisible();
		}
		await expect(dock.getByRole("button", { name: "Undo" })).toHaveCount(0);
		await dock.getByRole("button", { name: "Bold" }).tap();
		let loud = content(page).locator("strong, b").filter({ hasText: "loud" });
		await expect(loud).toHaveCount(1);
		await expect(content(page)).toBeFocused();
		// One formatting surface at a time.
		await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);

		// Undo and redo act on this writer's edits without taking the keyboard down.
		await page.keyboard.press("ArrowRight");
		await dock.getByRole("button", { name: "Undo" }).tap();
		await expect(loud).toHaveCount(0);
		await expect(content(page)).toBeFocused();
		await dock.getByRole("button", { name: "Redo" }).tap();
		await expect(loud).toHaveCount(1);

		// The way out is pinned, never scrolled off the row.
		let hide = dock.getByRole("button", { name: "Hide keyboard" });
		let pinned = await hide.evaluate(element => {
			let box = element.getBoundingClientRect();
			let row = element.closest("[role=toolbar]")!.getBoundingClientRect();
			return box.left >= row.left && box.right <= row.right && box.right <= innerWidth;
		});
		expect(pinned).toBe(true);

		await hide.tap();
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

test("the pencil focuses the editor afresh even when a reader's tap already focused it", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	await page.getByText("Second paragraph").tap();
	// iOS never moves focus to a tapped button: click without letting focus leave the root.
	await expect(content(page)).toBeFocused();
	await content(page).evaluate(root => {
		(window as typeof window & { focused?: number }).focused = 0;
		root.addEventListener("focus", () => (window as typeof window & { focused: number }).focused++);
	});
	await pencil(page).evaluate(button => (button as HTMLButtonElement).click());
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	expect(await page.evaluate(() => (window as typeof window & { focused?: number }).focused))
		.toBeGreaterThan(0);
	await expect(content(page)).toBeFocused();
});

test("the pencil opens the document from Chat and Decisions", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", PHONE);
	let tabs = page.getByRole("navigation", { name: "Workspace view" });
	for (let tab of [/^Chat/, /^Decisions/]) {
		await tabs.getByRole("button", { name: tab }).tap();
		await pencil(page).tap();
		await expect(page.locator('[data-document-view="plan"]')).toBeVisible();
		await expect(content(page)).toBeFocused();
		await done(page).tap();
	}
});

test("only the document's own keyboard gets the formatting dock", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE, fakeKeyboard);
	try {
		let dock = page.getByRole("toolbar", { name: "Formatting" });
		await pencil(page).tap();
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).tap();
		let composer = chatInput(page.getByRole("complementary", { name: "Chat", exact: true }));
		await composer.focus();
		await setVisualViewport(page, { event: "resize", height: 500 });
		await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", "");
		await expect(dock).toHaveCount(0);

		await setVisualViewport(page, { event: "resize", height: 844 });
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: "Document", exact: true }).tap();
		await page.locator(".phone-top-bar").getByRole("button", { name: /^Actions for / }).tap();
		// Phones open document actions as a sheet.
		await page.getByRole("dialog", { name: /^Actions for / })
			.getByRole("button", { name: "Rename", exact: true }).tap();
		await expect(page.getByRole("textbox", { name: "Document title" })).toBeFocused();
		await setVisualViewport(page, { event: "resize", height: 500 });
		await expect(dock).toHaveCount(0);
	} finally {
		await close();
	}
});

test("Insert stands in for the keyboard and gives the caret back", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE, fakeKeyboard);
	try {
		await page.getByText("Second paragraph").tap();
		await pencil(page).tap();
		await setVisualViewport(page, { event: "resize", height: 500 });
		let dock = page.getByRole("toolbar", { name: "Formatting" });
		let insert = dock.getByRole("button", { name: "Insert block" });
		await insert.tap();
		let panel = page.getByRole("group", { name: "Insert block" });
		await expect(panel).toBeFocused();
		await expect(insert).toHaveAttribute("aria-expanded", "true");
		// Focus left the editor, so the keyboard goes; the panel takes its place at its height.
		await setVisualViewport(page, { event: "resize", height: 844 });
		await expect(dock).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeHidden();
		let [panelBox, dockBox] = await Promise.all([panel.boundingBox(), dock.boundingBox()]);
		expect(Math.round(panelBox!.y + panelBox!.height)).toBe(844);
		expect(Math.round(panelBox!.height)).toBe(344);
		expect(Math.round(dockBox!.y + dockBox!.height)).toBeLessThanOrEqual(Math.round(panelBox!.y));
		for (let choice of await panel.getByRole("button").all()) {
			expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		}
		// The caret's paragraph stays in sight above the panel.
		let paragraph = content(page).locator("p").filter({ hasText: "Second paragraph" });
		expect((await paragraph.boundingBox())!.y + 12).toBeLessThanOrEqual(dockBox!.y);

		await panel.getByRole("button", { name: "Table" }).tap();
		await expect(content(page)).toBeFocused();
		await expect(content(page).locator("table")).toHaveCount(1);
		// The paragraph keeps its words: the table goes after it, not into it.
		await expect(content(page)).toContainText("Second paragraph for the caret.");
		await setVisualViewport(page, { event: "resize", height: 500 });
		await expect(panel).toHaveCount(0);
		await expect(dock).toBeVisible();
	} finally {
		await close();
	}
});

test("Text style turns the caret's block into a heading", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE, fakeKeyboard);
	try {
		await page.getByText("Second paragraph").tap();
		await pencil(page).tap();
		await setVisualViewport(page, { event: "resize", height: 500 });
		let dock = page.getByRole("toolbar", { name: "Formatting" });
		await dock.getByRole("button", { name: "Text style" }).tap();
		let panel = page.getByRole("group", { name: "Text style" });
		await expect(panel.getByRole("button", { name: "Text", exact: true }))
			.toHaveAttribute("aria-pressed", "true");
		// Escape, or the same button again, returns to the keyboard unchanged.
		await page.keyboard.press("Escape");
		await expect(content(page)).toBeFocused();
		await expect(panel).toHaveCount(0);

		await dock.getByRole("button", { name: "Text style" }).tap();
		await setVisualViewport(page, { event: "resize", height: 844 });
		await panel.getByRole("button", { name: "Heading 2" }).tap();
		await expect(content(page)).toBeFocused();
		await expect(content(page).locator("h2")).toHaveText("Second paragraph for the caret.");
		await page.keyboard.type("!");
		await expect(content(page).locator("h2")).toContainText("!");

		// Leaving the panel for anywhere else closes it and the dock with it.
		await dock.getByRole("button", { name: "Insert block" }).tap();
		await dock.getByRole("button", { name: "Hide keyboard" }).tap();
		await expect(dock).toHaveCount(0);
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	} finally {
		await close();
	}
});
