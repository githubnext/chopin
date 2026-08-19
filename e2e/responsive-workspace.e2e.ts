import { authenticate, content, expect, openIsolatedRoom, test } from "./room";
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
	let repository = header.getByRole("button", { name: /^Repository:/ });
	let document = header.locator("span[title]");
	let destinations = nav.getByRole("button");

	await expect(header.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
	await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
	await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
	await expect(destinations).toHaveCount(3);
	await expect(destinations.nth(0)).toHaveAccessibleName(/^Conversation/);
	await expect(destinations.nth(1)).toHaveAccessibleName("Plan");
	await expect(destinations.nth(2)).toHaveAccessibleName(/^Decisions/);

	let [headerBox, repositoryBox, documentBox] = await Promise.all([
		header.boundingBox(),
		repository.boundingBox(),
		document.boundingBox(),
	]);
	expect(headerBox).toBeTruthy();
	expect(repositoryBox).toBeTruthy();
	expect(documentBox).toBeTruthy();
	let geometry = {
		documentWidth: documentBox!.width,
		height: headerBox!.height,
		repositoryLabelCenter: repositoryBox!.y + repositoryBox!.height / 2,
		repositoryWidth: repositoryBox!.width,
		documentLabelCenter: documentBox!.y + documentBox!.height / 2,
	};
	expect(geometry.height).toBeLessThan(64);
	expect(geometry.documentWidth).toBeGreaterThan(geometry.repositoryWidth);
	expect(geometry.repositoryWidth).toBeGreaterThan(112);
	expect(Math.abs(geometry.repositoryLabelCenter - geometry.documentLabelCenter)).toBeLessThan(2);

	let heights = await destinations.evaluateAll(buttons =>
		buttons.map(button => button.getBoundingClientRect().height)
	);
	expect(heights.every(height => height >= 44)).toBe(true);
	await expectNoHorizontalOverflow(page);
}

test("a 390px phone has one row of chrome and exposes one mounted destination at a time", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await expectCompactWorkspaceChrome(page);
	await expect(nav.getByRole("button", { name: "Plan" })).toBeVisible();
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

test("a 320px phone has one row of chrome and one destination control", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", {
		hasTouch: true,
		viewport: { width: 320, height: 568 },
	});
	await expectCompactWorkspaceChrome(page);
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
		await setVisualViewport(page, {
			event: "resize",
			height: 506,
			offsetLeft: 12,
			offsetTop: 22,
			width: 320,
		});

		await expectInsideViewport(page.getByRole("button", { name: /^Repository:/ }));
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
	let geometry = {
		gap: navBox!.y - (mainBox!.y + mainBox!.height),
		hitInsideNavigation: await nav.evaluate(
			(element, box) =>
				element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
			buttonBox!,
		),
	};
	expect(geometry.gap).toBeGreaterThanOrEqual(8);
	expect(geometry.hitInsideNavigation).toBe(true);
});

test("the safe area shell contains nonzero top and bottom insets on a 430px phone", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 430, height: 932 });
	let cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setSafeAreaInsetsOverride", {
		insets: { bottom: 24, left: 0, right: 0, top: 20 },
	});
	page = await join("ana");
	let [bottom, top] = await Promise.all([
		page.getByRole("navigation", { name: "Workspace view" })
			.evaluate(element => getComputedStyle(element).paddingBottom),
		page.getByRole("banner").evaluate(element => getComputedStyle(element).paddingTop),
	]);
	let padding = { bottom, top };
	expect(padding).toEqual({ bottom: "28px", top: "28px" });
	await expectInsideViewport(page.getByRole("banner"));
	await expectInsideViewport(page.getByRole("navigation", { name: "Workspace view" }));
	await expectNoHorizontalOverflow(page);
});

test("phone landscape header and navigation respect inline safe areas", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 844, height: 390 });
	let cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setSafeAreaInsetsOverride", {
		insets: { bottom: 0, left: 32, right: 24, top: 0 },
	});
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
	let geometry = {
		headerLeft: headerFirst!.x,
		headerRight: headerLast!.x + headerLast!.width,
		navLeft: navFirst!.x,
		navRight: navLast!.x + navLast!.width,
	};
	expect(geometry.headerLeft).toBeGreaterThanOrEqual(32);
	expect(geometry.headerRight).toBeLessThanOrEqual(820);
	expect(geometry.navLeft).toBeGreaterThanOrEqual(32);
	expect(geometry.navRight).toBeLessThanOrEqual(820);
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

for (
	let viewport of [
		{ width: 768, height: 1024 },
		{ width: 1023, height: 964 },
		{ width: 1024, height: 768 },
		{ width: 1199, height: 900 },
	]
) {
	test(`${viewport.width}px uses the same compact destinations as a phone`, async ({ join, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let page = await join("ana", { viewport });
		let nav = page.getByRole("navigation", { name: "Workspace view" });
		let destinations = nav.getByRole("button");
		await expect(page.getByRole("button", { name: /conversation pane/ })).toHaveCount(0);
		await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
		await expect(destinations.nth(0)).toHaveAccessibleName(/^Conversation/);
		await expect(destinations.nth(1)).toHaveAccessibleName("Plan");
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

		await nav.getByRole("button", { name: "Plan", exact: true }).click();
		await expect(conversation).toBeHidden();
		await expect(content(page)).toBeVisible();
		await expect(page.locator("#workspace-plan-heading")).toBeFocused();

		await opener.click();
		await page.keyboard.press("Escape");
		await expect(conversation).toBeHidden();
		await expect(opener).toBeFocused();
		await expectNoHorizontalOverflow(page);
	});
}

for (let width of [1200, 1440]) {
	test(`${width}px retains the split Conversation layout`, async ({ join, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let page = await join("ana", { viewport: { width, height: 900 } });
		await expect(page.locator("#pane-chat")).toBeVisible();
		await expect(page.getByRole("separator", { name: "Resize the conversation" })).toBeVisible();
		await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /conversation pane/ })).toBeVisible();
		await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
		await expect(content(page)).toBeEditable();
	});
}

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
		let textarea = conversation.getByPlaceholder("Message the room — use @ai to ask Planner");
		await textarea.focus();
		await setVisualViewport(emulation.page, {
			event: "scroll",
			height: 506,
			offsetTop: 22,
		});
		await expect.poll(() =>
			emulation.page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--keyboard-inset").trim()
			)
		).toBe("316px");
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
