import { authenticate, content, expect, openIsolatedRoom, ready, test } from "./room";
import { chatInput, expectChatValue } from "./chat-input";
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
	let frame = page.locator(".workspace-frame");
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	let document = header.getByRole("button", { name: /^Actions for / });
	let destinations = nav.getByRole("button");

	await expect(header.getByRole("button", { name: /chat pane/ })).toHaveCount(0);
	await expect(page.getByRole("group", { name: "Document view" })).toHaveCount(0);
	await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
	await expect(destinations).toHaveCount(3);
	await expect(destinations.nth(0)).toHaveAccessibleName(/^Chat/);
	await expect(destinations.nth(1)).toHaveAccessibleName("Document");
	await expect(destinations.nth(2)).toHaveAccessibleName(/^Decisions/);

	await expectInsideViewport(header);
	await expectInsideViewport(projects);
	await expectInsideViewport(document);
	await expectInsideViewport(nav);
	let surface = await frame.evaluate(element => {
		let style = getComputedStyle(element);
		let bounds = element.getBoundingClientRect();
		return {
			left: bounds.left,
			overflow: style.overflow,
			radius: style.borderRadius,
			right: innerWidth - bounds.right,
			shadow: style.boxShadow,
		};
	});
	expect(surface.left).toBe(12);
	expect(surface.right).toBe(12);
	expect(surface.radius).toBe("12px");
	expect(surface.overflow).toBe("hidden");
	expect(surface.shadow).not.toBe("none");

	let heights = await destinations.evaluateAll(buttons =>
		buttons.map(button => button.getBoundingClientRect().height)
	);
	expect(heights.every(height => height >= 44)).toBe(true);
	await expectNoHorizontalOverflow(page);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
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
	await nav.getByRole("button", { name: /Chat/ }).click();
	await expect(chatPane(page)).toBeVisible();
	await expect(page.locator('[aria-label="editable markdown"]')).toBeHidden();
	await expect(page.locator("main")).toHaveAttribute("inert", "");
	await nav.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(chatPane(page)).toBeHidden();
	await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test(
	"the 700px frame boundary preserves mounted panes, drafts, and keyboard controls",
	async ({ join, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let page = await join("ana", { viewport: { width: 900, height: 850 } });
		let editor = content(page);
		let chat = chatPane(page);
		let draft = chatInput(chat);
		await draft.fill("An unfinished thought across layouts");
		await page.evaluate(() => {
			let saved = window as typeof window & {
				__workspaceEditor?: Element | null;
				__workspaceChat?: Element | null;
			};
			saved.__workspaceEditor = document.querySelector('[aria-label="editable markdown"]');
			saved.__workspaceChat = document.querySelector(".workspace-chat-panel");
		});

		let fromCompactChat = false;
		for (let width of [724, 723, 724]) {
			await page.setViewportSize({ width, height: 850 });
			let split = width >= 724;
			await expect(page.locator("[data-workspace-mode]")).toHaveAttribute(
				"data-workspace-mode",
				split ? "split" : "compact",
			);
			if (split) {
				await expect(chat).toBeVisible();
				await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
				await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
				let views = page.getByRole("group", { name: "Document view" });
				await expect(views).toBeVisible();
				if (width === 724 && fromCompactChat) {
					await page.getByRole("button", { name: "Close sidebar" }).click();
					await expect(chat).toBeHidden();
					let showChat = page.getByRole("button", { name: "Show chat pane" });
					await expect(showChat).toBeFocused();
					await showChat.click();
					await expect(chat).toBeVisible();
					await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeFocused();
					fromCompactChat = false;
				}
				if (width === 724) {
					let decisions = views.getByRole("button", { name: /^Decisions/ });
					let documentButton = views.getByRole("button", { name: "Document" });
					await documentButton.focus();
					await documentButton.press("Tab");
					await expect(decisions).toBeFocused();
					await expectInsideViewport(decisions);
					let toolbarBounds = (await page.locator("[data-document-toolbar]").boundingBox())!;
					let decisionBounds = (await decisions.boundingBox())!;
					expect(decisionBounds.x).toBeGreaterThanOrEqual(toolbarBounds.x);
					expect(decisionBounds.x + decisionBounds.width)
						.toBeLessThanOrEqual(toolbarBounds.x + toolbarBounds.width);
					await decisions.press("Enter");
					await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
					await documentButton.focus();
					await expectInsideViewport(documentButton);
					await documentButton.press("Enter");
					await expect(editor).toBeEditable();
				}
			} else {
				let nav = page.getByRole("navigation", { name: "Workspace view" });
				await expect(nav).toBeVisible();
				await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
				await nav.getByRole("button", { name: /^Chat/ }).click();
				await expect(chat).toBeVisible();
				await expectChatValue(draft, "An unfinished thought across layouts");
				await nav.getByRole("button", { name: "Document" }).click();
				await expect(editor).toBeEditable();
				if (width === 723) {
					await nav.getByRole("button", { name: /^Chat/ }).click();
					fromCompactChat = true;
				}
			}
			expect(
				await page.evaluate(() => {
					let saved = window as typeof window & {
						__workspaceEditor?: Element | null;
						__workspaceChat?: Element | null;
					};
					return saved.__workspaceEditor
							=== document.querySelector('[aria-label="editable markdown"]')
						&& saved.__workspaceChat === document.querySelector(".workspace-chat-panel");
				}),
			).toBe(true);
			await expectChatValue(draft, "An unfinished thought across layouts");
			await expectNoHorizontalOverflow(page);
		}

		await page.setViewportSize({ width: 900, height: 850 });
		let handle = page.getByRole("separator", { name: "Resize chat" });
		await expect.poll(async () => {
			let frame = await page.locator(".workspace-frame").boundingBox();
			return Number(await handle.getAttribute("aria-valuemax")) - (frame!.width - 450);
		}).toBeCloseTo(0, 0);
		let preferredWidth = Number(await handle.getAttribute("aria-valuemax"));
		await handle.press("End");
		await expect.poll(async () => (await chat.boundingBox())!.width)
			.toBeCloseTo(preferredWidth, 0);
		await page.setViewportSize({ width: 724, height: 850 });
		let main = page.locator(".workspace-frame main");
		await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(0);
		let views = page.getByRole("group", { name: "Document view" });
		let documentButton = views.getByRole("button", { name: "Document" });
		let decisions = views.getByRole("button", { name: /^Decisions/ });
		await documentButton.focus();
		await documentButton.press("Tab");
		await expect(decisions).toBeFocused();
		await expectInsideViewport(decisions);
		let toolbarBounds = (await page.locator("[data-document-toolbar]").boundingBox())!;
		let decisionBounds = (await decisions.boundingBox())!;
		expect(decisionBounds.x).toBeGreaterThanOrEqual(toolbarBounds.x);
		expect(decisionBounds.x + decisionBounds.width)
			.toBeLessThanOrEqual(toolbarBounds.x + toolbarBounds.width);
		await page.setViewportSize({ width: 900, height: 850 });
		await expect.poll(async () => (await chat.boundingBox())!.width).toBeCloseTo(preferredWidth, 0);
		await expect.poll(() => page.evaluate(() => localStorage.getItem("chopin:pane:chat")))
			.toBe(String(preferredWidth));
	},
);

test("content swaps retain one interactive destination across pointer and immediate paths", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let stack = page.locator("[data-workspace-document-swap]");
	let visible = stack.locator(":scope > [data-content-swap-state]:not([hidden])");
	let outgoing = stack.locator(
		':scope > [data-content-swap-state="outgoing"]:not([hidden])',
	);
	let decisions = nav.getByRole("button", { name: /^Decisions/ });
	let document = nav.getByRole("button", { name: "Document", exact: true });

	await decisions.click();
	await expect(visible).toHaveCount(2);
	await expect(stack.locator(":scope > [data-content-swap-state]:not([hidden]):not([inert])"))
		.toHaveCount(1);
	await expect(outgoing).toHaveCount(1);
	await expect(outgoing).toHaveAttribute("aria-hidden", "true");
	await expect(outgoing).toHaveAttribute("inert", "");
	let sampledCounts = await stack.evaluate(async element => {
		let counts: number[] = [];
		for (let sample = 0; sample < 5; sample += 1) {
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			counts.push(
				element.querySelectorAll(
					":scope > [data-content-swap-state]:not([hidden])",
				).length,
			);
		}
		return counts;
	});
	expect(sampledCounts).not.toContain(0);
	await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeFocused();
	await expect(visible).toHaveCount(1);

	await document.focus();
	await page.keyboard.press("Enter");
	await expect(visible).toHaveCount(1);
	await expect(outgoing).toHaveCount(0);

	await page.emulateMedia({ reducedMotion: "reduce" });
	await decisions.click();
	await expect(visible).toHaveCount(1);
	await expect(outgoing).toHaveCount(0);

	await page.emulateMedia({ reducedMotion: "no-preference" });
	await document.click();
	await expect(visible).toHaveCount(2);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(visible).toHaveCount(1, { timeout: 100 });

	await page.emulateMedia({ reducedMotion: "no-preference" });
	await decisions.click();
	await expect(visible).toHaveCount(2);
	await document.click();
	await expect(visible).toHaveCount(2);
	await expect(visible).toHaveCount(1);
	await expect(page.locator('[data-document-view="plan"]')).toBeVisible();
});

test("a pointer-dismissed Projects drawer becomes inert while it exits", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	let opener = page.getByRole("button", { name: "Open Projects sidebar" });
	await opener.click();
	let drawer = page.getByRole("dialog", { includeHidden: true, name: "Projects" }).locator("../..");
	await page.getByRole("button", { name: "Close Projects sidebar" }).click({
		position: { x: 382, y: 422 },
	});

	await expect(drawer).toHaveAttribute("aria-hidden", "true");
	await expect(drawer).toHaveAttribute("inert", "");
	await expect(opener).toBeFocused();
	await expect(drawer).toHaveCount(0);
});

test("enabling reduced motion settles an active drawer exit", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByRole("button", { name: "Open Projects sidebar" }).click();
	let drawer = page.getByRole("dialog", { includeHidden: true, name: "Projects" }).locator("../..");
	await page.getByRole("button", { name: "Close Projects sidebar" }).click({
		position: { x: 382, y: 422 },
	});
	await expect(drawer).toHaveAttribute("aria-hidden", "true");

	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(drawer).toHaveCount(0, { timeout: 100 });
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

		let sidebarButton = page.getByRole("button", { name: "Open Projects sidebar" });
		await expect(sidebarButton).toBeVisible();
		await expectInsideViewport(sidebarButton);
		let workspaceNavigation = page.getByRole("navigation", { name: "Workspace view" });
		await expect(workspaceNavigation).toBeVisible();
		await expectInsideViewport(workspaceNavigation);
	} finally {
		await context.close();
	}
});

test("the document surface leaves the top navigation unobstructed", async ({ join, seed }) => {
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
	expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(mainBox!.y);
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

test("landscape split controls respect inline safe areas", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 844, height: 390 });
	let cdp = await page.context().newCDPSession(page);
	let safeArea = { bottom: 0, left: 32, right: 24, top: 0 };
	await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
	page = await join("ana");
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	let header = page.getByRole("banner");
	let headerControls = header.getByRole("button");
	let chatToggle = page.getByRole("button", { name: "Close sidebar" });
	let viewControls = page.getByRole("group", { name: "Document view" }).getByRole("button");
	let [headerFirst, headerLast, chatButton, viewFirst, viewLast] = await Promise.all([
		headerControls.first().boundingBox(),
		headerControls.last().boundingBox(),
		chatToggle.boundingBox(),
		viewControls.first().boundingBox(),
		viewControls.last().boundingBox(),
	]);
	expect(headerFirst).toBeTruthy();
	expect(headerLast).toBeTruthy();
	expect(chatButton).toBeTruthy();
	expect(viewFirst).toBeTruthy();
	expect(viewLast).toBeTruthy();
	let viewportWidth = await page.evaluate(() => visualViewport!.width);
	expect(headerFirst!.x).toBeGreaterThanOrEqual(safeArea.left);
	expect(headerLast!.x + headerLast!.width).toBeLessThanOrEqual(
		viewportWidth - safeArea.right,
	);
	expect(chatButton!.x).toBeGreaterThanOrEqual(safeArea.left);
	expect(viewFirst!.x).toBeGreaterThanOrEqual(safeArea.left);
	expect(viewLast!.x + viewLast!.width).toBeLessThanOrEqual(viewportWidth - safeArea.right);
	await expectInsideViewport(chatToggle);
	await expectInsideViewport(viewControls.last());
	await expectNoHorizontalOverflow(page);
});

test("an 844px landscape viewport keeps the split workspace", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 844, height: 390 } });
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Chat" })).toHaveCount(0);
	await expect(content(page)).toBeEditable();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("the Projects drawer below 1024px keeps the split workspace", async ({ join, seed }) => {
	let viewport = { width: 1023, height: 964 };
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport });
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	await expect(projects).toBeVisible();
	await projects.click();
	let drawer = page.getByRole("dialog", { name: "Projects" });
	await expect(drawer).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await expect(projects).toBeFocused();
	await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
	let chat = page.getByRole("complementary", { name: "Chat" });
	await expect(chat).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Chat" })).toHaveCount(0);
	await expect(content(page)).toBeEditable();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
	await page.getByRole("button", { name: "Close sidebar" }).click();
	await expect(chat).toBeHidden();
	let opener = page.getByRole("button", { name: "Show chat pane" });
	await expect(opener).toBeFocused();
	await opener.click();
	await expect(chat).toBeVisible();
	await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeFocused();
	await chatInput(chat).press("Escape");
	await expect(chat).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("the wide Projects sidebar leaves the workspace unobstructed", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 1024, height: 768 } });
	let projects = page.getByRole("complementary", { includeHidden: true, name: "Projects" });
	let opener = page.getByRole("button", { name: "Open Projects sidebar" });
	let track = projects.locator("../..");
	await expect(projects).toBeVisible();
	await expect(opener).toHaveCount(0);
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	await expect(chatPane(page)).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
	let documentView = page.getByRole("group", { name: "Document view" });
	await expect(documentView).toBeVisible();
	let content = page.locator(".navigation-content");
	let sidebarBounds = (await track.boundingBox())!;
	let contentBounds = (await content.boundingBox())!;
	expect(sidebarBounds.x + sidebarBounds.width).toBeLessThanOrEqual(contentBounds.x);
	await expect(documentView.getByRole("button", { name: "Tasks & Progress" })).toHaveCount(0);
	await expect(documentView.getByRole("button", { name: "Background Work" })).toHaveCount(0);

	await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
	await expect(track).toHaveAttribute("aria-hidden", "true");
	await expect(track).toHaveAttribute("inert", "");
	await expect(opener).toBeFocused();
	await expect(track).toHaveCount(0);

	await opener.click();
	await expect(projects).toBeVisible();
	sidebarBounds = (await track.boundingBox())!;
	contentBounds = (await content.boundingBox())!;
	expect(sidebarBounds.x + sidebarBounds.width).toBeLessThanOrEqual(contentBounds.x);
	await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
	await expect(track).toHaveAttribute("aria-hidden", "true");
	await opener.click();
	await expect(track).not.toHaveAttribute("aria-hidden", "true");
	await expect(track).not.toHaveAttribute("inert", "");
	await expect(track).toHaveCount(1);
	await expect(projects).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("a representative desktop retains the split Chat layout", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(chatPane(page)).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toBeVisible();
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();
	await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
	await expect(content(page)).toBeEditable();
});

test("200% zoom at 640 CSS pixels uses compact controls without clipping", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", {
		screen: { width: 1280, height: 900 },
		viewport: { width: 640, height: 450 },
	});
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
	await expect(content(page)).toBeEditable();
	await expectNoHorizontalOverflow(page);
	await page.setViewportSize({ width: 480, height: 450 });
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("Chromium visual viewport emulation keeps Chat controls above the keyboard", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let emulation = await emulatedVisualViewportPage(browser, baseURL!, room);
	try {
		let nav = emulation.page.getByRole("navigation", { name: "Workspace view" });
		await nav.getByRole("button", { name: /Chat/ }).click();
		let chat = emulation.page.getByRole("complementary");
		let textarea = chatInput(chat);
		await textarea.focus();
		await setVisualViewport(emulation.page, {
			event: "scroll",
			height: 506,
			offsetTop: 22,
		});
		await expectInsideViewport(textarea);
		await expectInsideViewport(
			chat.getByRole("button", { name: "Send message" }),
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
		await expect(sheet.getByRole("button", { name: "Resize comment sheet" })).toBeFocused();
		let composer = sheet.getByPlaceholder("Reply…");
		await composer.focus();
		await setVisualViewport(emulation.page, {
			event: "resize",
			height: 506,
			offsetTop: 0,
		});
		await expect(async () => {
			await expectInsideViewport(composer);
			await expectInsideViewport(sheet.getByRole("button", { name: "Send reply" }));
		}).toPass();
	} finally {
		await emulation.close();
	}
});
