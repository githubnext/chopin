/**
 * The two things that appear because of where the caret is.
 *
 * Both are placed by measurement against a live rectangle, so neither can be
 * covered by `bun test` — `bubble.test.ts` and `slash.test.ts` cover the
 * decisions those measurements feed, and stop at the point where a browser is
 * required. Everything here is on the other side of that line.
 */

import { authenticate, content, expect, openIsolatedRoom, roomPath, test, written } from "./room";
import { expectInsideViewport } from "./responsive";
import { installVisualViewport } from "./visual-viewport";

import type { Browser, Locator, Page } from "@playwright/test";

let MENU = { name: "Insert block" };
let BUBBLE = { name: "Text formatting" };
let LONG_EDITOR = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");

async function emulatedVisualViewportPage(
	browser: Browser,
	baseURL: string,
	room: string,
): Promise<{ close: () => Promise<void>; page: Page }> {
	return openIsolatedRoom(browser, baseURL, room, "ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	}, context =>
		installVisualViewport(context, {
			height: 640,
			offsetLeft: 0,
			offsetTop: 72,
			pageLeft: 0,
			pageTop: 0,
			scale: 1,
			width: 390,
		}));
}

async function expectSurfaceToFollowEditorScroll(
	page: Page,
	surface: Locator,
): Promise<void> {
	// The surface's passive effect owns the scroll listeners; wait one frame so
	// this exercise is about their geometry rather than React effect scheduling.
	await page.waitForTimeout(32);
	let scroller = page.locator("[data-plan-scroll]");
	let beforeScroll = await scroller.evaluate(element => element.scrollTop);
	let beforeRange = await page.evaluate(() =>
		getSelection()!.getRangeAt(0).getBoundingClientRect().top
	);
	let beforeSurface = await surface.boundingBox();
	let beforeSelection = await page.evaluate(() => {
		let box = getSelection()!.getRangeAt(0).getBoundingClientRect();
		return { bottom: box.bottom, top: box.top };
	});
	expect(beforeSurface).not.toBeNull();
	let beforeDistance = Math.max(
		beforeSurface!.y - beforeSelection.bottom,
		beforeSelection.top - (beforeSurface!.y + beforeSurface!.height),
	);
	expect(beforeDistance).toBeGreaterThanOrEqual(0);
	let beforeAboveSelection = beforeSurface!.y + beforeSurface!.height <= beforeSelection.top;
	await scroller.evaluate(element => {
		element.scrollTop += 72;
	});
	await expect.poll(() => scroller.evaluate(element => element.scrollTop))
		.toBeGreaterThan(beforeScroll + 50);
	await expect.poll(() =>
		page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top)
	).toBeLessThan(beforeRange - 50);
	// Dispatch after the range has its post-scroll layout. This keeps the test
	// deterministic across Chromium's compositor and main-thread scroll paths.
	await scroller.dispatchEvent("scroll");
	await expect.poll(async () => {
		let box = await surface.boundingBox();
		if (!box) return false;
		let range = await page.evaluate(() => {
			let box = getSelection()!.getRangeAt(0).getBoundingClientRect();
			return { bottom: box.bottom, top: box.top };
		});
		let distance = Math.max(box.y - range.bottom, range.top - (box.y + box.height));
		let movedWithSelection = beforeAboveSelection
			? box.y + box.height < beforeSurface!.y + beforeSurface!.height
			: box.y < beforeSurface!.y;
		return movedWithSelection && distance >= 0 && distance <= beforeDistance;
	}).toBe(true);
	await expectInsideViewport(surface);
}

async function insertCallout(page: Page) {
	await content(page).click();
	await page.keyboard.type("/callout");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Callout" }).click();
	return content(page).locator("aside[data-plan-type]");
}

test("filtering resets the option Enter will choose", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/");

	let menu = page.getByRole("listbox", MENU);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.type("call");

	await expect(menu.getByRole("option", { selected: true })).toHaveText("Callout");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("combobox", { name: "Change callout type: Note" })).toBeVisible();
});

test("slash menu Arrow navigation changes selection without colour transitions", async ({ join, page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await join("ana");
	await content(page).click();
	await page.keyboard.type("/");

	let menu = page.getByRole("listbox", MENU);
	await expect(menu).toBeVisible();
	let selected = menu.getByRole("option", { selected: true });
	let initial = await selected.textContent();
	await selected.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	await page.evaluate(() => {
		let record = { properties: [] as string[], starts: 0 };
		Reflect.set(window, "__immediateMenuTransitions", record);
		document.addEventListener("transitionstart", event => {
			if (
				event instanceof TransitionEvent
				&& event.target instanceof Element
				&& event.target.matches(".plan-menu-row, .plan-menu-cell")
			) {
				record.properties.push(event.propertyName);
				if (["background-color", "color"].includes(event.propertyName)) record.starts++;
			}
		}, true);
	});

	await page.keyboard.press("ArrowDown");
	await expect(selected).not.toHaveText(initial!);
	await selected.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	let transitions = await page.evaluate(() =>
		Reflect.get(window, "__immediateMenuTransitions") as {
			properties: string[];
			starts: number;
		}
	);
	expect(transitions).toEqual({ properties: [], starts: 0 });
});

test("a callout edits like prose and keeps its type controls out of the way", async ({ join, room }) => {
	let page = await join("ana");
	let callout = await insertCallout(page);
	await expect(callout).toHaveAttribute("data-plan-type", "note");
	let title = callout.getByRole("textbox", { name: "Callout title" });
	let trigger = callout.getByRole("combobox", { name: "Change callout type: Note" });
	await expect(page.getByRole("listbox", { name: "Callout type" })).toHaveCount(0);
	await title.fill("Worth knowing");

	await trigger.click();
	let types = page.getByRole("listbox", { name: "Callout type" });
	await expect(types).toBeVisible();
	await types.getByRole("option", { name: "Warning" }).click();

	await expect(callout).toHaveAttribute("data-plan-type", "warning");
	await expect(title).toHaveText("Worth knowing");
	await written(page, room, /type="warning" title="Worth knowing"/);
});

test("enter twice leaves a legacy callout at the end of the plan", async ({ join, room, seedLegacyCallout }) => {
	await seedLegacyCallout(
		`<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">\n\nKeep this in the callout.\n\n</Callout>`,
	);
	let page = await join("ana");
	let callout = content(page).locator("aside[data-plan-type]");
	let body = callout.locator("[data-plan-body]");
	await expect(body.locator(":scope > p")).toHaveCount(1);

	await expect(body.locator(":scope > p")).toHaveText("Keep this in the callout.");
	await body.locator(":scope > p").evaluate(element => {
		let range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		let selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(2);
	await page.keyboard.type("Still in it.");
	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(3);
	await expect(body.locator(":scope > p").last()).toBeEmpty();

	await page.keyboard.press("Enter");
	await expect(body.locator(":scope > p")).toHaveCount(2);
	await page.keyboard.type("Outside the callout.");

	await expect(body.locator(":scope > p")).toHaveCount(2);
	await expect(callout).toContainText("Keep this in the callout.");
	await expect(callout).toContainText("Still in it.");
	await expect(callout).not.toContainText("Outside the callout.");
	await written(
		page,
		room,
		/Keep this in the callout\.[\s\S]*Still in it\.[\s\S]*<\/Callout>[\s\S]*Outside the callout\./,
	);
});

test("escape closes the menu and leaves what was typed", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/tab");
	await expect(page.getByRole("listbox", MENU)).toBeVisible();

	await page.keyboard.press("Escape");

	await expect(page.getByRole("listbox", MENU)).toHaveCount(0);
	await expect(content(page)).toContainText("/tab");
});

test("choosing a table inserts one, with a header", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/table");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Table" }).click();

	await expect(content(page).locator("table")).toHaveCount(1);
	await expect(content(page).locator("th")).toHaveCount(3);
	await expect(content(page).locator("tr")).toHaveCount(3);

	// The query that summoned it has to go: leaving "/table" above the table
	// is the menu writing its own invocation into the document.
	await expect(content(page)).not.toContainText("/table");
});

test("a selection raises exactly one toolbar", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	// Two toolbars is the ported defect: one from the plugin list and one from
	// the surface, stacked, so the top one takes every click and the other is
	// only visible as a shadow slightly out of register.
	await expect(page.getByRole("toolbar", BUBBLE)).toHaveCount(1);
});

test("a formatting glyph shows its label on hover", async ({ join }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	let bold = page.getByRole("toolbar", BUBBLE).getByRole("button", { name: "Bold" });
	await bold.hover();
	let tooltip = page.locator("[data-icon-tooltip]");
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText("Bold");
	await page.mouse.move(0, 0);
	await expect(tooltip).toBeHidden();
});

test("a mark from the toolbar reaches the file", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Pick a storage format.");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await bubble.getByRole("button", { name: "Bold" }).click();
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await written(page, room, /^\*\*Pick a storage format\.\*\*$/m);
});

test("the block type menu converts the block it names", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("What we are building");
	await page.keyboard.press("Shift+Home");

	let bubble = page.getByRole("toolbar", BUBBLE);
	await bubble.getByRole("button", { name: "Block type: Text" }).click();

	// The submenu replaces the toolbar's contents rather than opening beside
	// it, so there is never a second popup to decide between.
	await expect(bubble.getByRole("button", { name: "Bold" })).toHaveCount(0);
	await bubble.getByRole("button", { name: "Heading 2" }).click();

	await expect(content(page).getByRole("heading", { level: 2 })).toHaveText(
		"What we are building",
	);
	await written(page, room, /^## What we are building$/m);
});

test("escape lets go of a selection and keeps the caret in the editor", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Let this selection go.");
	await page.keyboard.press("Shift+Home");
	await expect(page.getByRole("toolbar", BUBBLE)).toBeVisible();

	await page.keyboard.press("Escape");

	await expect(page.getByRole("toolbar", BUBBLE)).toHaveCount(0);
	await expect(content(page)).toBeFocused();
	expect(await page.evaluate(() => getSelection()?.isCollapsed)).toBe(true);
});

test("a link is added, edited and removed in place", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Read the docs.");
	await page.keyboard.press("Shift+Home");
	await page.getByRole("toolbar", BUBBLE).getByRole("button", { name: "Add link" }).click();

	let adding = page.getByRole("form", { name: "Add link" });
	let field = adding.getByRole("textbox", { name: "Link URL" });
	await expect(field).toBeFocused();
	await expect(page.getByRole("toolbar", BUBBLE)).toHaveCount(0);

	// Tab cycles inside the popover instead of leaving it open behind focus.
	await page.keyboard.press("Tab");
	await expect(adding.getByRole("button", { name: "Add link" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(field).toBeFocused();

	/*
	 * Refused where the field is, not where the document is. A URL the
	 * dialect rejects applies locally, syncs, and is then refused by the
	 * server — which cannot undo a Yjs transaction, so it rebuilds the room
	 * under a fresh epoch and everybody in it loses their cursors.
	 */
	await field.fill("javascript:alert(1)");
	await page.keyboard.press("Enter");
	await expect(adding.getByRole("alert")).toHaveText(
		"Use an https:// or mailto: link, or a path in this repository.",
	);
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await expect(content(page).locator("a")).toHaveCount(0);

	// A bare domain is taken to mean the web, not a repository path.
	await field.fill("example.com/docs");
	await page.keyboard.press("Enter");
	await expect(adding).toHaveCount(0);
	await expect(content(page)).toBeFocused();
	let link = content(page).getByRole("link", { name: "Read the docs." });
	await expect(link).toHaveAttribute("href", "https://example.com/docs");
	await written(page, room, /^\[Read the docs\.\]\(https:\/\/example\.com\/docs\)$/m);

	// The caret on a link is enough to show where it goes.
	await link.click();
	let preview = page.getByRole("dialog", { name: "Link" });
	await expect(preview).toContainText("https://example.com/docs");
	await expect(preview.getByRole("button", { name: "Open" })).toBeVisible();

	// And the keyboard can follow it without reaching for the preview.
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>" }),
	);
	let popup = page.waitForEvent("popup");
	await page.keyboard.press("ControlOrMeta+Enter");
	let opened = await popup;
	await expect(opened).toHaveURL("https://example.com/docs");
	await opened.close();
	await expect(content(page).getByRole("link")).toHaveCount(1);
	await preview.getByRole("button", { name: "Edit" }).click();

	let editing = page.getByRole("form", { name: "Edit link" });
	await expect(editing.getByRole("textbox", { name: "Link URL" })).toHaveValue(
		"https://example.com/docs",
	);
	await expect(editing.getByRole("textbox", { name: "Link URL" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(editing).toHaveCount(0);
	await expect(content(page)).toBeFocused();

	// The shortcut opens the same editor from a caret inside the link.
	await page.keyboard.press("ControlOrMeta+k");
	await editing.getByRole("textbox", { name: "Link URL" }).fill("https://example.com/guide");
	await page.keyboard.press("Enter");
	await written(page, room, /^\[Read the docs\.\]\(https:\/\/example\.com\/guide\)$/m);

	await link.click();
	await preview.getByRole("button", { name: "Edit" }).click();
	await editing.getByRole("button", { name: "Remove" }).click();
	await expect(content(page).locator("a")).toHaveCount(0);
	await expect(content(page)).toBeFocused();
	await written(page, room, /^Read the docs\.$/m);
});

/** Select a phrase by its text, as a person dragging across it would. */
async function selectText(page: Page, text: string): Promise<void> {
	await content(page).evaluate((root, target) => {
		let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let index = node.textContent!.indexOf(target);
			if (index < 0) continue;
			let range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + target.length);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(range);
			return;
		}
		throw new Error(`no text ${target}`);
	}, text);
}

test("another writer's edit cannot move a new link onto other text", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");

	await content(ana).click();
	await ana.keyboard.type("Alpha Bravo Zeb Delta.");
	await expect(content(bo)).toContainText("Alpha Bravo Zeb Delta.");

	await selectText(ana, "Zeb");
	await ana.keyboard.press("ControlOrMeta+k");
	let adding = ana.getByRole("form", { name: "Add link" });
	await adding.getByRole("textbox", { name: "Link URL" }).fill("example.com/zeb");

	// Text arrives earlier in the same paragraph while the field is open.
	await selectText(bo, "Alpha");
	await bo.keyboard.press("ArrowLeft");
	await bo.keyboard.type("123456789 ");
	await expect(content(ana)).toContainText("123456789 Alpha");
	await expect(adding).toBeVisible();

	await ana.keyboard.press("Enter");
	await expect(content(ana).getByRole("link", { name: "Zeb", exact: true })).toHaveAttribute(
		"href",
		"https://example.com/zeb",
	);
	await written(
		ana,
		room,
		/^123456789 Alpha Bravo \[Zeb\]\(https:\/\/example\.com\/zeb\) Delta\.$/m,
	);

	// If the text itself is replaced, nothing is linked and the editor says why.
	await selectText(ana, "Delta");
	await ana.keyboard.press("ControlOrMeta+k");
	await adding.getByRole("textbox", { name: "Link URL" }).fill("example.com/delta");
	await selectText(bo, "Delta");
	await bo.keyboard.type("Echo");
	await expect(content(ana)).toContainText("Zeb Echo.");

	await ana.keyboard.press("Enter");
	await expect(adding.getByRole("status")).toHaveText(
		"Someone else changed this text. Select it again to add the link.",
	);
	await expect(content(ana).getByRole("link")).toHaveCount(1);
	await adding.getByRole("button", { name: "Close" }).click();
	await expect(adding).toHaveCount(0);
	await written(
		ana,
		room,
		/^123456789 Alpha Bravo \[Zeb\]\(https:\/\/example\.com\/zeb\) Echo\.$/m,
	);
});

test("a reader can open a link but not edit it", async ({ baseURL, browser, room, seed }) => {
	await seed("Read [the docs](https://example.com/docs).\n");
	let context = await browser.newContext({ baseURL });
	await context.route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>" }),
	);
	let page = await context.newPage();
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	await expect(content(page)).toHaveAttribute("contenteditable", "false", { timeout: 20_000 });

	await content(page).getByRole("link", { name: "the docs" }).click();
	let preview = page.getByRole("dialog", { name: "Link" });
	await expect(preview).toContainText("https://example.com/docs");
	await expect(preview.getByRole("button", { name: "Edit" })).toHaveCount(0);

	let popup = page.waitForEvent("popup");
	await preview.getByRole("button", { name: "Open" }).click();
	let opened = await popup;
	await expect(opened).toHaveURL("https://example.com/docs");
	expect(await opened.evaluate(() => opener === null)).toBe(true);
	await opened.close();

	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);
	await context.close();
});

test("touch editor menus use reachable targets and stay inside the viewport", async ({ join }) => {
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});

	await content(page).click();
	await page.keyboard.type("/");
	let menu = page.getByRole("listbox", MENU);
	await expect(menu).toBeVisible();
	let rowHeights = await menu.getByRole("option").evaluateAll(options =>
		options.map(option => option.getBoundingClientRect().height)
	);
	expect(rowHeights.every(height => height >= 44)).toBe(true);
	await expectInsideViewport(menu);

	await page.keyboard.press("Escape");
	await content(page).click();
	await page.keyboard.type("Format this selection.");
	await page.keyboard.press("Shift+Home");
	let bubble = page.getByRole("toolbar", BUBBLE);
	await expect(bubble).toBeVisible();
	let targets = await bubble.getByRole("button").evaluateAll(buttons =>
		buttons.map(button => {
			let box = button.getBoundingClientRect();
			return { height: box.height, width: box.width };
		})
	);
	expect(targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
	await expectInsideViewport(bubble);
});

test("an open slash menu follows its caret while the editor scrolls", async ({ baseURL, browser, room, seed }) => {
	await seed(LONG_EDITOR);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let block = content(emulation.page).getByText("Paragraph 9.", { exact: true });
		await block.scrollIntoViewIfNeeded();
		await block.selectText();
		await emulation.page.keyboard.type("/");
		let menu = emulation.page.getByRole("listbox", MENU);
		await expect(menu).toBeVisible();

		await expectSurfaceToFollowEditorScroll(emulation.page, menu);
	} finally {
		await emulation.close();
	}
});

test("an open selection toolbar follows its range while the editor scrolls", async ({ baseURL, browser, room, seed }) => {
	await seed(LONG_EDITOR);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let block = content(emulation.page).getByText("Paragraph 9.", { exact: true });
		await block.scrollIntoViewIfNeeded();
		await block.selectText();
		let bubble = emulation.page.getByRole("toolbar", BUBBLE);
		await expect(bubble).toBeVisible();

		await expectSurfaceToFollowEditorScroll(emulation.page, bubble);
	} finally {
		await emulation.close();
	}
});
