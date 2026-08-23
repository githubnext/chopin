import { authenticate, content, expect, openIsolatedRoom, ready, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow, RESPONSIVE_SOURCE } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { Browser, Page } from "@playwright/test";

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
			height: 844,
			offsetLeft: 0,
			offsetTop: 0,
			pageLeft: 0,
			pageTop: 0,
			scale: 1,
			width: 390,
		}));
}

async function expectCompactWorkspaceChrome(page: Page): Promise<void> {
	let header = page.getByRole("banner");
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	let document = header.getByRole("button", { name: /^Rename / });
	let destinations = nav.getByRole("button");

	await expect(header.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
	await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
	await expect(destinations).toHaveCount(4);
	await expect(destinations.nth(0)).toHaveAccessibleName(/^Conversation/);
	await expect(destinations.nth(1)).toHaveAccessibleName("Document");
	await expect(destinations.nth(2)).toHaveAccessibleName(/^Decisions/);
	await expect(destinations.nth(3)).toHaveAccessibleName(/^Background Work/);

	await expectInsideViewport(header);
	await expectInsideViewport(projects);
	await expectInsideViewport(document);
	await expectInsideViewport(nav);

	let heights = await destinations.evaluateAll(buttons =>
		buttons.map(button => button.getBoundingClientRect().height)
	);
	expect(heights.every(height => height >= 44)).toBe(true);
	await expectNoHorizontalOverflow(page);
}

test("viewport containment rejects absent and invisible targets", async ({ page }) => {
	await page.setContent(`
		<button hidden id="hidden" type="button">Hidden target</button>
		<button id="empty" style="border: 0; height: 0; padding: 0; width: 0" type="button"></button>
	`);
	for (let selector of ["#missing", "#hidden", "#empty"]) {
		await expect(expectInsideViewport(page.locator(selector))).rejects.toThrow();
	}
});

test("a representative compact phone exposes one mounted destination at a time", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await expectCompactWorkspaceChrome(page);
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	await projects.click();
	let drawer = page.getByRole("dialog", { name: "Projects" });
	await expect(drawer).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await expect(projects).toBeFocused();
	await expect(nav.getByRole("button", { name: "Document" })).toBeVisible();
	await nav.getByRole("button", { name: /Conversation/ }).click();
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.locator('[aria-label="editable markdown"]')).toBeHidden();
	await expect(page.locator("main")).toHaveAttribute("inert", "");
	await nav.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(page.locator("#pane-chat")).toBeHidden();
	await expect(page.locator("#workspace-decisions-heading")).toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test("a shifted visual viewport keeps workspace controls in the exposed rectangle", async ({ browser, baseURL, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let context = await browser.newContext({
		baseURL,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		await installVisualViewport(context, {
			height: 844,
			offsetLeft: 0,
			offsetTop: 0,
			pageLeft: 0,
			pageTop: 0,
			scale: 1,
			width: 390,
		});
		let page = await context.newPage();
		await authenticate(page, "ana", baseURL!);
		await page.goto(`/channels/${room}`);
		await ready(page);
		await setVisualViewport(page, {
			event: "resize",
			height: 506,
			offsetLeft: 12,
			offsetTop: 22,
			width: 320,
		});

		await expectInsideViewport(page.getByRole("button", { name: "Open Projects sidebar" }));
		await expectInsideViewport(page.getByRole("navigation", { name: "Workspace view" }));
	} finally {
		await context.close();
	}
});

test("the document surface leaves the bottom navigation unobstructed", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let [mainBox, navBox, buttonBox] = await Promise.all([
		page.locator("main").boundingBox(),
		nav.boundingBox(),
		nav.getByRole("button").first().boundingBox(),
	]);
	expect(mainBox).toBeTruthy();
	expect(navBox).toBeTruthy();
	expect(buttonBox).toBeTruthy();
	let hitInsideNavigation = await nav.evaluate(
		(element, box) =>
			element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
		buttonBox!,
	);
	expect(navBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height);
	expect(hitInsideNavigation).toBe(true);
});

test("the safe area shell contains nonzero top and bottom insets on a 430px phone", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 430, height: 932 });
	let cdp = await page.context().newCDPSession(page);
	let safeArea = { bottom: 24, left: 0, right: 0, top: 20 };
	await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
	page = await join("ana");
	let [headerControl, navigationControl, viewport] = await Promise.all([
		page.getByRole("banner").getByRole("button").first().boundingBox(),
		page.getByRole("navigation", { name: "Workspace view" }).getByRole("button").first()
			.boundingBox(),
		page.evaluate(() => visualViewport!.height),
	]);
	expect(headerControl).toBeTruthy();
	expect(navigationControl).toBeTruthy();
	expect(headerControl!.y).toBeGreaterThanOrEqual(safeArea.top);
	expect(navigationControl!.y + navigationControl!.height)
		.toBeLessThanOrEqual(viewport - safeArea.bottom);
	await expectInsideViewport(page.getByRole("banner"));
	await expectInsideViewport(page.getByRole("navigation", { name: "Workspace view" }));
	await expectNoHorizontalOverflow(page);
});

test("phone landscape header and navigation respect inline safe areas", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 844, height: 390 });
	let cdp = await page.context().newCDPSession(page);
	let safeArea = { bottom: 0, left: 32, right: 24, top: 0 };
	await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
	page = await join("ana");
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let header = page.getByRole("banner");
	let headerControls = header.getByRole("button");
	let navControls = nav.getByRole("button");
	let [headerFirst, headerLast, navFirst, navLast] = await Promise.all([
		headerControls.first().boundingBox(),
		headerControls.last().boundingBox(),
		navControls.first().boundingBox(),
		navControls.last().boundingBox(),
	]);
	expect(headerFirst).toBeTruthy();
	expect(headerLast).toBeTruthy();
	expect(navFirst).toBeTruthy();
	expect(navLast).toBeTruthy();
	let viewportWidth = await page.evaluate(() => visualViewport!.width);
	expect(headerFirst!.x).toBeGreaterThanOrEqual(safeArea.left);
	expect(headerLast!.x + headerLast!.width).toBeLessThanOrEqual(
		viewportWidth - safeArea.right,
	);
	expect(navFirst!.x).toBeGreaterThanOrEqual(safeArea.left);
	expect(navLast!.x + navLast!.width).toBeLessThanOrEqual(viewportWidth - safeArea.right);
	await expectInsideViewport(nav);
	await expectNoHorizontalOverflow(page);
});

test("a phone landscape still exposes one destination at a time", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 844, height: 390 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await nav.getByRole("button", { name: /Conversation/ }).click();
	await expect(page.getByRole("complementary", { name: "Conversation" })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Conversation" })).toHaveCount(0);
	await expect(content(page)).toBeHidden();
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("the compact side of the Projects transition keeps phone navigation", async ({ join, seed }) => {
	let viewport = { width: 1023, height: 964 };
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let destinations = nav.getByRole("button");
	await expect(page.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
	await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
	await expect(destinations.nth(0)).toHaveAccessibleName(/^Conversation/);
	await expect(destinations.nth(1)).toHaveAccessibleName("Document");
	await expect(destinations.nth(2)).toHaveAccessibleName(/^Decisions/);

	let opener = nav.getByRole("button", { name: /^Conversation/ });
	await opener.click();
	let conversation = page.getByRole("complementary", { name: "Conversation" });
	await expect(conversation).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Conversation" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Close conversation" })).toHaveCount(0);
	await expect(content(page)).toBeHidden();
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
	await expect(page.locator("#workspace-conversation-heading")).toBeFocused();

	await nav.getByRole("button", { name: "Document", exact: true }).click();
	await expect(conversation).toBeHidden();
	await expect(content(page)).toBeVisible();
	await expect(page.locator("#workspace-plan-heading")).toBeFocused();

	await opener.click();
	await expect(conversation).toBeVisible();
	await expect(page.locator("#workspace-conversation-heading")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(conversation).toBeHidden();
	await expect(opener).toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test("the wide side of the Projects transition uses the inline sidebar", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 1024, height: 768 } });
	await expect(page.getByRole("complementary", { name: "Projects" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Open Projects sidebar" })).toHaveCount(0);
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toBeVisible();
	await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("a representative desktop retains the split Conversation layout", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toBeVisible();
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /conversation pane/ })).toBeVisible();
	await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
	await expect(content(page)).toBeEditable();
});

test("200% zoom resolves to the compact presentation without clipping", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", {
		screen: { width: 1280, height: 900 },
		viewport: { width: 640, height: 450 },
	});
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await expect(nav).toBeVisible();
	await nav.getByRole("button", { name: /Conversation/ }).click();
	await expect(page.getByRole("complementary", { name: "Conversation" })).toBeVisible();
	await expect(content(page)).toBeHidden();
	await expectNoHorizontalOverflow(page);
});

test("Chromium visual viewport emulation keeps Conversation controls above the keyboard", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let nav = emulation.page.getByRole("navigation", { name: "Workspace view" });
		await nav.getByRole("button", { name: /Conversation/ }).click();
		let conversation = emulation.page.getByRole("complementary");
		let textarea = conversation.getByPlaceholder("Use @chopin to ask Chopin");
		await textarea.focus();
		await setVisualViewport(emulation.page, {
			event: "scroll",
			height: 506,
			offsetTop: 22,
		});
		await expectInsideViewport(textarea);
		await expectInsideViewport(
			conversation.getByRole("button", { name: "Send message" }),
		);
	} finally {
		await emulation.close();
	}
});

test("Chromium visual viewport emulation keeps document editing above the keyboard", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let editor = content(emulation.page);
		await editor.focus();
		await setVisualViewport(emulation.page, {
			event: "resize",
			height: 506,
			offsetTop: 0,
		});
		await expectInsideViewport(editor.locator(":scope > p").first());
		await expectInsideViewport(emulation.page.getByRole("navigation", { name: "Workspace view" }));
	} finally {
		await emulation.close();
	}
});

test("a touch comment sheet keeps its composer above the visual keyboard", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let marker = emulation.page.getByRole("button", { name: /Comment on “/ }).first();
		await marker.tap();
		let sheet = emulation.page.getByRole("dialog", { name: "Comment thread" });
		await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();
		let composer = sheet.getByPlaceholder("Reply…");
		await composer.focus();
		await setVisualViewport(emulation.page, {
			event: "resize",
			height: 506,
			offsetTop: 0,
		});
		await expectInsideViewport(composer);
		await expectInsideViewport(sheet.getByRole("button", { name: "Reply" }));
	} finally {
		await emulation.close();
	}
});
