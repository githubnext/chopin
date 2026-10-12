/**
 * A child document on a phone reads like its parent: it opens for reading, the tab bar's pencil
 * edits the child rather than the parent beneath it, formatting docks above the keyboard, and its
 * decisions save from the phone's bar. Desktop children and viewers are unchanged.
 */

import { seedChildChannel } from "./database";
import { authenticate, content, expect, openIsolatedRoom, test } from "./room";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PROMPT = "Where should room state live?";
const CHILD_SOURCE = `# Source review

This child compares where unsent edits could live.

Second paragraph for the caret.
`;

async function openChild(
	browser: Browser,
	baseURL: string,
	room: string,
	handle: string,
	options: Parameters<Browser["newContext"]>[0],
	before?: (context: BrowserContext) => Promise<void>,
	source = CHILD_SOURCE,
) {
	let title = `Child ${crypto.randomUUID().slice(0, 8)}`;
	let child = await seedChildChannel(
		Number(new URL(baseURL).port),
		room,
		crypto.randomUUID(),
		title,
		source,
	);
	let context = await browser.newContext({ ...options, baseURL });
	await before?.(context);
	let page = await context.newPage();
	await authenticate(page, handle, baseURL);
	await page.goto(child.path);
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(surface.locator("[data-plan-synced]")).toBeAttached({ timeout: 20_000 });
	return { context, page, surface };
}

const LONG = (name: string) =>
	`# ${name}\n\n${
		Array.from({ length: 30 }, (_, index) => `${name} passage ${index + 1}.`).join("\n\n")
	}\n`;

function fakeKeyboard(context: BrowserContext) {
	return installVisualViewport(context, {
		height: 844,
		offsetLeft: 0,
		offsetTop: 0,
		pageLeft: 0,
		pageTop: 0,
		scale: 1,
		width: 390,
	});
}

/**
 * Edit from a paragraph low on the screen, then raise the keyboard: the formatting dock comes
 * up over where that paragraph was, and the paragraph must end up above the dock.
 */
async function expectCaretClearOfDock(page: Page, editor: Locator) {
	let paragraphs = editor.locator(":scope > p");
	let low = await paragraphs.evaluateAll(items =>
		items.findIndex(item => {
			let box = item.getBoundingClientRect();
			return box.top > 560 && box.bottom < 740;
		})
	);
	expect(low).toBeGreaterThanOrEqual(0);
	let paragraph = paragraphs.nth(low);
	await paragraph.tap();
	await pencil(page).tap();
	await expect(editor).toBeFocused();
	await setVisualViewport(page, { event: "resize", height: 500 });
	let dock = page.getByRole("toolbar", { name: "Formatting" });
	await expect(dock).toBeVisible();
	await dock.evaluate(element =>
		Promise.all(
			element.closest("[data-phone-tab-row]")!.getAnimations({ subtree: true })
				.map(animation => animation.finished),
		)
	);
	await expect.poll(async () => {
		let row = (await dock.boundingBox())!;
		let block = (await paragraph.boundingBox())!;
		return block.y + block.height <= row.y && block.y >= 0;
	}).toBe(true);
}

function pencil(page: Page) {
	return page.getByRole("button", { name: "Edit document" });
}

function done(page: Page) {
	return page.getByRole("button", { name: "Done editing" });
}

function childText(surface: ReturnType<Page["getByRole"]>) {
	return surface.getByRole("textbox", { name: "editable markdown" });
}

function parentText(page: Page) {
	return page.locator('[data-document-view="plan"]:not([data-workspace-surface="child"] *)')
		.getByRole("textbox", { name: "editable markdown" });
}

test("a child opens for reading on a phone and the tab bar's pencil edits it", async ({ baseURL, browser, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let { context, page, surface } = await openChild(browser, baseURL!, room, "ana", PHONE);
	try {
		await expect(childText(surface)).toHaveAttribute("contenteditable", "false");
		// One pencil, in the parent's tab bar, sized for a thumb.
		await expect(pencil(page)).toHaveCount(1);
		let tabs = page.getByRole("navigation", { name: "Workspace view" });
		await expect(tabs).toBeVisible();
		expect((await pencil(page).boundingBox())!.width).toBeGreaterThanOrEqual(44);

		// Tapping prose reads; it raises no keyboard.
		await surface.getByText("Second paragraph").tap();
		expect(
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.isContentEditable),
		)
			.toBeFalsy();

		await pencil(page).tap();
		await expect(childText(surface)).toHaveAttribute("contenteditable", "true");
		await expect(childText(surface)).toBeFocused();
		await expect(done(page)).toBeVisible();
		await expect(page.locator(".phone-top-bar-mode")).toHaveText("Editing");
		// The parent beneath keeps reading.
		await expect(parentText(page)).toHaveAttribute("contenteditable", "false");
		await page.keyboard.type("Typed ");
		await expect(childText(surface)).toContainText("Typed ");

		// From another tab, the pencil brings the child back before editing it.
		await done(page).tap();
		await expect(childText(surface)).toHaveAttribute("contenteditable", "false");
		await tabs.getByRole("button", { name: /^Chat/ }).tap();
		await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
		await pencil(page).tap();
		await expect(surface).toBeVisible();
		await expect(childText(surface)).toHaveAttribute("contenteditable", "true");
		await expect(childText(surface)).toBeFocused();
	} finally {
		await context.close();
	}
});

test("a child's formatting docks above the keyboard in the parent's bar", async ({ baseURL, browser, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let { context, page, surface } = await openChild(
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
		await surface.getByText("Second paragraph").tap();
		await pencil(page).tap();
		await setVisualViewport(page, { event: "resize", height: 500 });
		let dock = page.getByRole("toolbar", { name: "Formatting" });
		await expect(dock).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeHidden();
		await page.keyboard.type("loud");
		for (let step = 0; step < 4; step++) await page.keyboard.press("Shift+ArrowLeft");
		await dock.getByRole("button", { name: "Bold" }).tap();
		await expect(childText(surface).locator("strong, b").filter({ hasText: "loud" }))
			.toHaveCount(1);
		await expect(childText(surface)).toBeFocused();

		await dock.getByRole("button", { name: "Hide keyboard" }).tap();
		await setVisualViewport(page, { event: "resize", height: 844 });
		await expect(dock).toHaveCount(0);
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	} finally {
		await context.close();
	}
});

test("a child's decisions save from the phone's bar", async ({ baseURL, browser, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let { context, page, surface } = await openChild(browser, baseURL!, room, "ana", PHONE);
	try {
		let card = surface.locator("article[data-plan-sidecar-questionnaire]")
			.filter({ has: page.getByRole("heading", { name: PROMPT }) });
		await card.scrollIntoViewIfNeeded();
		await expect(card.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
		let bar = surface.locator(".decision-save-bar");
		await expect(bar).not.toHaveAttribute("data-open");

		await card.getByText("In SQLite", { exact: true }).tap();
		let region = surface.getByRole("region", { name: "Unsaved answers" });
		await expect(region.getByRole("status")).toHaveText("1 unsaved answer");
		let save = region.getByRole("button", { name: "Save", exact: true });
		expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		// It rests above the tab bar, not under it.
		await region.evaluate(element =>
			Promise.all(element.getAnimations().map(animation => animation.finished))
		);
		let tabs = (await page.getByRole("navigation", { name: "Workspace view" }).boundingBox())!;
		let rest = (await region.boundingBox())!;
		expect(rest.y + rest.height).toBeLessThanOrEqual(tabs.y);

		await region.getByRole("button", { name: "Clear", exact: true }).tap();
		await expect(bar).not.toHaveAttribute("data-open");
		await expect(card.getByRole("radio", { name: /In SQLite/ })).not.toBeChecked();

		await card.getByText("In SQLite", { exact: true }).tap();
		await save.tap();
		await expect(bar).not.toHaveAttribute("data-open");
		await expect(card.getByRole("radio", { name: /In SQLite/ })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("a child keeps no reading mode for viewers on a phone or anyone on desktop", async ({ baseURL, browser, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let viewer = await openChild(browser, baseURL!, room, "readonly", PHONE);
	try {
		await expect(childText(viewer.surface)).toHaveAttribute("contenteditable", "false");
		await expect(viewer.page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
		await expect(pencil(viewer.page)).toHaveCount(0);
		await expect(done(viewer.page)).toHaveCount(0);
	} finally {
		await viewer.context.close();
	}

	let desktop = await openChild(browser, baseURL!, room, "ana", {
		viewport: { width: 1440, height: 900 },
	});
	try {
		await expect(childText(desktop.surface)).toHaveAttribute("contenteditable", "true");
		await expect(pencil(desktop.page)).toHaveCount(0);
		await expect(desktop.surface.locator(".decision-save-bar")).toHaveCount(0);
		let card = desktop.surface.locator("article[data-plan-sidecar-questionnaire]")
			.filter({ has: desktop.page.getByRole("heading", { name: PROMPT }) });
		await card.scrollIntoViewIfNeeded();
		await card.getByText("In SQLite", { exact: true }).click();
		await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
	} finally {
		await desktop.context.close();
	}
});

test("opening a child ends the parent's editing; the child opens for reading", async ({ baseURL, join, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let title = `Child ${crypto.randomUUID().slice(0, 8)}`;
	await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		title,
		CHILD_SOURCE,
	);
	let page = await join("ana", PHONE);
	await pencil(page).tap();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");

	await page.locator(".phone-top-bar").getByRole("button", { name: "Documents", exact: true })
		.click();
	await page.getByRole("dialog", { name: "Documents" }).getByRole("link", { name: title }).click();
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	await expect(childText(surface)).toHaveAttribute("contenteditable", "false");
	await expect(parentText(page)).toHaveAttribute("contenteditable", "false");
	await expect(pencil(page)).toBeVisible();
	await expect(done(page)).toHaveCount(0);
});

test("the formatting dock keeps the caret's block clear in a root document", async ({ baseURL, browser, room, seed }) => {
	await seed(LONG("Root"));
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE, fakeKeyboard);
	try {
		await expectCaretClearOfDock(page, content(page));
	} finally {
		await close();
	}
});

test("the formatting dock keeps the caret's block clear in a child document", async ({ baseURL, browser, room, seed }) => {
	await seed("# Parent\n\nThe parent stays put beneath its child.\n");
	let { context, page, surface } = await openChild(
		browser,
		baseURL!,
		room,
		"ana",
		PHONE,
		fakeKeyboard,
		LONG("Child"),
	);
	try {
		await expectCaretClearOfDock(page, childText(surface));
	} finally {
		await context.close();
	}
});
