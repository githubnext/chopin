import { chatInput } from "./chat-input";
import { seedChildChannel } from "./database";
import { installPointerMedia } from "./pointer-media";
import { recordRoomMounts } from "./room-mounts";
import { authenticate, expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PARENT_SOURCE = `# Parent document

${Array.from({ length: 36 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

const CHILD_SOURCE = `# Source review

This ordinary child has its own editable document, Decisions, and inline comments.
`;

const LINKED_PARENT_SOURCE = `# Parent document

[Parent source](https://example.com/parent-source)
`;

const LINKED_CHILD_SOURCE = `# Source review

[Child source](https://example.com/child-source)
`;

function rootSheet(page: Page, room: string) {
	return page.locator(
		`[data-workspace-room="${room}"] > .workspace-frame > .workspace-document-stack > .workspace-document-panel`,
	);
}

function titleBar(page: Page, room: string) {
	return rootSheet(page, room).locator("[data-document-title-bar]");
}

/** Pins Lift, which stays available behind the development toggle; Zoom is the default. */
async function useLift(page: Page) {
	await page.addInitScript(() => localStorage.setItem("chopin:dev:child-motion", "lift"));
}

/**
 * Back to the root: the title bar's arrow under Zoom, the stack bar's in compact, or under Lift
 * an empty stretch of the root's peeking title bar.
 */
async function returnToRoot(page: Page, room: string) {
	let name = `Back to Test ${room.slice(0, 8)}`;
	let back = page.getByRole("navigation", { name: "Document stack" })
		.getByRole("button", { name })
		.or(titleBar(page, room).locator(".document-title-slot").getByRole("button", { name }));
	let rowReturn = titleBar(page, room).locator(".workspace-tab-row-return");
	await expect(back.or(rowReturn)).toBeVisible();
	if (await back.isVisible()) await back.click();
	else {
		let bar = titleBar(page, room);
		let gap = await bar.evaluate(row => {
			let box = row.getBoundingClientRect();
			for (let x = box.left + 4; x < box.right; x += 4) {
				let hit = document.elementFromPoint(x, box.top + box.height / 2);
				if (hit?.classList.contains("workspace-tab-row-return")) return x - box.left;
			}
			return null;
		});
		expect(gap).not.toBeNull();
		await bar.click({ position: { x: gap!, y: (await bar.boundingBox())!.height / 2 } });
	}
}

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

test("authored links open from parent and child documents", async ({ baseURL, join, page, room, seed }) => {
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Authored source</title>" }),
	);
	await seed(LINKED_PARENT_SOURCE);
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		`Linked child ${room.slice(0, 8)}`,
		LINKED_CHILD_SOURCE,
	);
	await join("ana");

	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let parentLink = parent.getByRole("link", { name: "Parent source", exact: true });
	// A click shows where the link goes; opening it is one more deliberate step.
	await parentLink.click();
	let parentPopupPromise = page.waitForEvent("popup");
	await page.getByRole("dialog", { name: "Link" }).getByRole("button", { name: "Open" }).click();
	let parentPopup = await parentPopupPromise;
	await expect(parentPopup).toHaveURL("https://example.com/parent-source");
	expect(await parentPopup.evaluate(() => opener === null)).toBe(true);
	await parentPopup.close();

	let sidebar = page.getByRole("complementary", { name: "Projects" });
	await sidebar.getByRole("link", { name: `Linked child ${room.slice(0, 8)}`, exact: true })
		.click();
	let surface = page.getByRole("region", {
		name: `Child document: Linked child ${room.slice(0, 8)}`,
	});
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();

	let childLink = surface.getByRole("link", { name: "Child source", exact: true });
	await childLink.click();
	let childPopupPromise = page.waitForEvent("popup");
	await page.getByRole("dialog", { name: "Link" }).getByRole("button", { name: "Open" }).click();
	let childPopup = await childPopupPromise;
	await expect(childPopup).toHaveURL("https://example.com/child-source");
	await childPopup.close();
});

async function captureChatSends(page: Page) {
	let sends: { channelId: string; text: string; to: Chat.Destination }[] = [];
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		let channelId = new URL(route.url()).searchParams.get("channel");
		route.onMessage(message => {
			if (typeof message === "string" && channelId) {
				try {
					let frame = JSON.parse(message) as Partial<Chat.Send>;
					if (
						frame.kind === "chat:send"
						&& typeof frame.text === "string"
						&& (frame.to === "room" || frame.to === "planner")
					) sends.push({ channelId, text: frame.text, to: frame.to });
				} catch {
					// The real server remains authoritative for malformed and non-chat frames.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return () => sends.map(send => ({ ...send }));
}

test("a Lift child keeps the parent title bar as its stack and nested geometry", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Chrome source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	// A child inherits the parent's Chat state; closed here so the parent is expanded.
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:choice", "false"));
	await useLift(page);
	await join("ana");
	await page.setViewportSize({ width: 1920, height: 1080 });
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	let childLink = sidebar.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	let sheet = rootSheet(page, room);
	let parentBar = titleBar(page, room);
	let tabs = sheet.locator("[data-document-toolbar]");
	await expect(page.getByRole("banner")).toHaveCount(0);
	await expect(parentBar.locator(".document-title-slot")).toContainText(`Test ${room.slice(0, 8)}`);
	await expect(parentBar).not.toContainText(childTitle);
	await expect(sheet.locator("[data-workspace-document-swap]")).toHaveAttribute("inert", "");
	// The child lifts over the root's views; the root's title bar stays above it as the stack.
	await expect(tabs).toHaveAttribute("inert", "");
	await expect(parentBar.getByRole("group", { includeHidden: true, name: /People here:/ }))
		.toBeVisible();
	let childBar = surface.locator("[data-child-title-bar]");
	await expect(childBar.getByRole("group", { name: `Document: ${childTitle}` })).toBeVisible();
	await expect(childBar.getByRole("group", { name: /People here:/ })).toHaveCount(0);
	await expect(
		surface.getByRole("button", { name: /^(Document|Decisions|Show chat|Expand document)/ }),
	).toHaveCount(0);
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	expect(await sheet.evaluate(element => getComputedStyle(element).transform)).not.toBe("none");
	await expect(sheet.locator(".workspace-child-scrim")).toHaveCSS("opacity", "0.45");
	let barBox = (await parentBar.boundingBox())!;
	let cardBox = (await surface.boundingBox())!;
	let sheetBox = (await sheet.boundingBox())!;
	expect(cardBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
	expect(cardBox.width).toBeGreaterThan(sheetBox.width);
	expect(await page.locator(".anchored-child-shadow").evaluate(e => getComputedStyle(e).boxShadow))
		.not.toBe("none");

	let resize = page.getByRole("separator", { name: "Resize Projects sidebar" });
	let resizeBox = await resize.boundingBox();
	let sidebarWidth = Number(await resize.getAttribute("aria-valuenow"));
	expect(resizeBox).not.toBeNull();
	await page.mouse.move(resizeBox!.x + resizeBox!.width - 0.5, resizeBox!.y + 80);
	await page.mouse.down();
	await page.mouse.move(resizeBox!.x + resizeBox!.width + 31.5, resizeBox!.y + 80);
	await page.mouse.up();
	await expect(resize).toHaveAttribute("aria-valuenow", String(sidebarWidth + 32));
	await expect(surface).toBeVisible();

	await returnToRoot(page, room);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("the root's Chat stays live while a child is open, across every close path", async ({ baseURL, join, page, room, seed }) => {
	test.slow();
	await seed(PARENT_SOURCE);
	let childTitle = `Isolated source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	let chatSends = await captureChatSends(page);
	await page.setViewportSize({ width: 1920, height: 1080 });
	await join("ana");
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let sheet = rootSheet(page, room);
	let parentChat = parent.getByRole("complementary", {
		name: "Chat",
		includeHidden: true,
	});
	let parentRoomMessage = `Parent room message ${room.slice(0, 8)}`;
	let parentDraft = chatInput(parentChat);
	await parentDraft.fill(parentRoomMessage);
	await parentChat.getByRole("button", { name: "Send message" }).click();
	await expect(parentChat.getByText(parentRoomMessage, { exact: true })).toBeVisible();

	let parentScroll = parent.locator("[data-plan-scroll]");
	await parentScroll.evaluate(element => element.scrollTop = 180);
	let parentScrollTop = await parentScroll.evaluate(element => element.scrollTop);
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	let childLink = sidebar.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();
	await expect(surface.getByRole("complementary", { name: "Chat" })).toHaveCount(0);
	await expect(parentChat).not.toHaveAttribute("inert", "");
	await expect(parentChat).toContainText(parentRoomMessage);
	let whileOpen = `Root message while child open ${room.slice(0, 8)}`;
	await parentDraft.fill(whileOpen);
	await parentChat.getByRole("button", { name: "Send message" }).click();
	await expect(parentChat.getByText(whileOpen, { exact: true })).toBeVisible();
	await expect.poll(chatSends).toContainEqual({ channelId: room, text: whileOpen, to: "room" });
	expect(chatSends().some(send => send.channelId === child.id)).toBe(false);

	let childEditor = surface.getByRole("textbox", { name: "editable markdown" });
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await childEditor.locator("p").first().selectText();
	await surface.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let commentDraft = surface.getByRole("dialog", { name: "New comment" });
	await expect(commentDraft.getByPlaceholder("Add a comment")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(commentDraft).toHaveCount(0);
	await expect(surface).toBeVisible();

	async function expectClosed() {
		await expect(surface).toHaveCount(0);
		await expect(childLink).toBeFocused();
		await expect(page).toHaveURL(url => url.pathname === child.path.replace(/\/children\/.*$/, ""));
		await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(
			parentScrollTop,
		);
		await expect(parentChat).toContainText(parentRoomMessage);
	}
	async function reopen() {
		await childLink.click();
		await expect(surface).toBeVisible();
	}

	// 1. The title bar's root crumb, pressed twice in one task: only one close happens.
	await sheet.locator("[data-document-title-bar]")
		.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).evaluate(button => {
			(button as HTMLButtonElement).click();
			(button as HTMLButtonElement).click();
		});
	await expectClosed();

	// 2. Escape.
	await reopen();
	await page.keyboard.press("Escape");
	await expectClosed();

	// 3. Browser Back.
	await reopen();
	await page.goBack();
	await expectClosed();

	// 4. The title bar's arrow, a pointer target beside the crumb.
	await reopen();
	await sheet.locator("[data-document-title-bar] .document-title-back").click();
	await expectClosed();
	await reopen();
	await expect(chatSends().filter(send => send.channelId === child.id)).toHaveLength(0);
});

test("Escape in root Chat stays in Chat while a child is open", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Chat escape source ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let parentChat = page.locator(`[data-workspace-room="${room}"]`)
		.getByRole("complementary", { name: "Chat" });
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();

	let draft = chatInput(parentChat);
	await draft.fill(`Draft while child open ${room.slice(0, 8)}`);
	await draft.focus();
	await page.keyboard.press("Escape");
	await expect(draft).toBeFocused();
	await expect(surface).toBeVisible();

	let send = parentChat.getByRole("button", { name: "Send message" });
	await send.focus();
	await page.keyboard.press("Escape");
	await expect(send).toBeFocused();
	await expect(surface).toBeVisible();
});

test("Tab from an open child never reaches covered root content, and root Chat stays reachable", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Tab source ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let parentChat = parent.getByRole("complementary", { name: "Chat" });
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeFocused();
	let reachedChat = false;
	for (let press = 0; press < 60; press++) {
		await page.keyboard.press("Tab");
		let where = await page.evaluate(() => {
			let active = document.activeElement;
			return {
				chat: active !== null && active.closest("[data-workspace-room] aside") !== null,
				covered: active?.closest("[data-workspace-document-swap]") !== null
					&& active?.closest(".anchored-child-card") === null,
			};
		});
		expect(where.covered).toBe(false);
		if (where.chat) reachedChat = true;
	}
	expect(reachedChat).toBe(true);
	await expect(parentChat).toBeVisible();
});

test("Lift keeps the child for the surface toggle and presence, returns for the title bar and the child's close", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Lift source ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await useLift(page);
	await join("ana");
	let tabs = titleBar(page, room);
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await childLink.focus();
	await childLink.click();
	await expect(surface).toBeVisible();
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));

	let toggle = tabs.locator(".workspace-surface-toggle-slot button");
	await toggle.click();
	await toggle.click();
	await expect(surface).toBeVisible();
	await tabs.getByRole("group", { includeHidden: true, name: /People here:/ })
		.click({ force: true });
	await expect(surface).toBeVisible();

	// Enter on the return control closes once and hands focus back to the opener.
	let back = tabs.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` });
	await back.focus();
	let focusTrail = await page.evaluateHandle(() => {
		let trail = { body: false, done: false };
		let watch = () => {
			let closing = document.querySelector(".anchored-child-card") !== null;
			if (closing && document.activeElement === document.body) trail.body = true;
			if (!trail.done) requestAnimationFrame(watch);
		};
		watch();
		return trail;
	});
	await page.keyboard.press("Enter");
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	// Focus stays on the return control through the 250ms close, then lands on the opener.
	expect(
		await focusTrail.evaluate(trail => {
			trail.done = true;
			return trail.body;
		}),
	).toBe(false);
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));

	// A click on the root's covered title returns rather than renaming it.
	await childLink.click();
	await expect(surface).toBeVisible();
	let [slotBox, barBox] = await Promise.all([
		tabs.locator(".document-title-slot").boundingBox(),
		tabs.boundingBox(),
	]);
	await tabs.click({ position: { x: slotBox!.x - barBox!.x + 24, y: barBox!.height / 2 } });
	await expect(surface).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Document title" })).toHaveCount(0);

	await childLink.click();
	await expect(surface).toBeVisible();
	await surface.locator("[data-child-title-bar]")
		.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
});

test("an in-app child preserves and restores its mounted parent", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.addInitScript(() => {
		localStorage.setItem("chopin:pane:chat:choice", "true");
		localStorage.setItem("chopin:pane:chat", "384");
	});
	await join("ana");

	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let parentChat = parent.getByRole("complementary", {
		name: "Chat",
		includeHidden: true,
	});
	await expect(parent.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	let parentScroll = parent.locator("[data-plan-scroll]");
	await expect(parent.getByRole("separator", { name: "Resize chat" }))
		.toHaveAttribute("aria-valuenow", "384");
	await expect(parentChat).toBeVisible();
	await page.evaluate(() => localStorage.setItem("chopin:view:document", "decisions"));
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	await parentScroll.evaluate(element => element.scrollTop = 240);
	let originalScroll = await parentScroll.evaluate(element => element.scrollTop);
	await page.evaluate(() => history.replaceState({ navigation: 4 }, "", "?view=plan#note"));
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	let sheet = rootSheet(page, room);
	await expect(sheet.locator('[data-document-view="plan"]')).toHaveAttribute("inert", "");
	await expect(titleBar(page, room)).not.toHaveAttribute("inert", "");
	// Under Zoom the child has no views, so the root's fold away while it is open.
	await expect(sheet.locator("[data-document-toolbar]")).toHaveAttribute("data-folded", "true");
	await expect(surface.getByRole("complementary", { name: "Chat" })).toHaveCount(0);
	await expect(parentChat).toBeVisible();
	await expect(surface.getByRole("button", { name: "Decisions", exact: true })).toHaveCount(0);
	await expect(surface.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.getByRole("button", { name: "Tasks & Progress", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(surface.locator('[data-document-view="plan"]')).toBeVisible();
	await expect(surface.locator('[data-document-view="decisions"]')).toHaveCount(0);
	await expect(parentChat).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#note"
	);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(originalScroll);
	await expect(parentChat).toBeVisible();

	await childLink.click();
	await expect(surface).toBeVisible();
	await expect(parentChat).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await returnToRoot(page, room);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("an in-app child opens and submits its own comment composer", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Commentable child ${room.slice(0, 8)}`;
	let passage = "This ordinary child has its own editable document, Decisions, and Chat.";
	await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		`# Source review\n\n${passage}\n`,
	);
	await join("ana");

	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true })
		.click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeFocused();
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await surface.getByRole("textbox", { name: "editable markdown" })
		.getByText(passage, { exact: true })
		.selectText();
	await surface.getByRole("button", { name: "Comment on this passage", exact: true }).click();

	let draft = surface.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Add a comment").fill("Keep this child passage.");
	await draft.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(surface.getByRole("button", { name: /Comment on “This ordinary child/ }))
		.toBeVisible();
});

test("a delayed sibling route removes the previous editable child immediately", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let firstTitle = `First source ${room.slice(0, 8)}`;
	let secondTitle = `Second source ${room.slice(0, 8)}`;
	let first = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		firstTitle,
		CHILD_SOURCE,
	);
	let second = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		secondTitle,
		CHILD_SOURCE,
	);
	await join("ana");
	await page.evaluate(() => history.replaceState({ navigation: 9 }, "", "?view=plan#siblings"));
	let childLink = (title: string) =>
		page.getByRole("complementary", { name: "Projects" })
			.getByRole("link", { name: title, exact: true });
	await childLink(firstTitle).click();
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();

	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route(
		`**/api/repositories/octo-org/score/documents/${second.slug}`,
		async route => {
			let response = await route.fetch();
			await gate;
			await route.fulfill({ response });
		},
	);
	await childLink(secondTitle).click();
	await expect(page).toHaveURL(url => url.pathname === second.path);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toHaveCount(0);
	await expect(page.locator(".anchored-child-card")).toContainText("Opening child document…");

	release();
	let secondSurface = page.getByRole("region", { name: `Child document: ${secondTitle}` });
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await expect(secondSurface).toBeFocused();
	await returnToRoot(page, room);
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(secondSurface).toHaveCount(0);
	await expect(childLink(secondTitle)).toBeFocused();

	await childLink(firstTitle).click();
	await childLink(secondTitle).click();
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await page.evaluate(() => {
		let held = new Map<number, FrameRequestCallback>();
		let next = 1;
		let state = window as typeof window & {
			__chopinHeldFrames?: {
				cancel: typeof cancelAnimationFrame;
				held: Map<number, FrameRequestCallback>;
				request: typeof requestAnimationFrame;
			};
		};
		state.__chopinHeldFrames = {
			cancel: window.cancelAnimationFrame,
			held,
			request: window.requestAnimationFrame,
		};
		window.requestAnimationFrame = callback => {
			let id = next++;
			held.set(id, callback);
			return id;
		};
		window.cancelAnimationFrame = id => held.delete(id);
	});
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(secondSurface).toHaveCount(0);
	expect(
		await page.evaluate(() => {
			let state = window as typeof window & {
				__chopinHeldFrames?: { held: Map<number, FrameRequestCallback> };
			};
			return state.__chopinHeldFrames?.held.size ?? 0;
		}),
	).toBeGreaterThan(0);
	await childLink(firstTitle).click();
	let firstSurface = page.getByRole("region", { name: `Child document: ${firstTitle}` });
	await expect(firstSurface.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();
	await page.evaluate(() => {
		let state = window as typeof window & {
			__chopinHeldFrames?: {
				cancel: typeof cancelAnimationFrame;
				held: Map<number, FrameRequestCallback>;
				request: typeof requestAnimationFrame;
			};
		};
		let frames = state.__chopinHeldFrames!;
		window.requestAnimationFrame = frames.request;
		window.cancelAnimationFrame = frames.cancel;
		for (let callback of frames.held.values()) callback(performance.now());
		delete state.__chopinHeldFrames;
	});
	await expect(firstSurface).toBeFocused();
	await expect(childLink(secondTitle)).not.toBeFocused();
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await page.keyboard.press("Escape");
	await expect(firstSurface).toHaveCount(0);
	await expect(childLink(firstTitle)).toBeFocused();

	await childLink(firstTitle).click();
	await childLink(secondTitle).click();
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toHaveCount(0);
	await expect(childLink(secondTitle)).toBeFocused();
});

test("a direct child keeps direct-entry history when opening a sibling", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let firstTitle = `Direct first ${room.slice(0, 8)}`;
	let secondTitle = `Direct second ${room.slice(0, 8)}`;
	let first = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		firstTitle,
		CHILD_SOURCE,
	);
	let second = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		secondTitle,
		CHILD_SOURCE,
	);
	await authenticate(page, "ana", baseURL!);
	await page.goto(first.path);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();
	let historyLength = await page.evaluate(() => history.length);
	let secondLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: secondTitle, exact: true });

	await secondLink.click();
	let secondSurface = page.getByRole("region", { name: `Child document: ${secondTitle}` });
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	expect(await page.evaluate(() => history.length)).toBe(historyLength);
	await returnToRoot(page, room);
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === ""
		&& url.hash === ""
	);
	await expect(secondSurface).toHaveCount(0);
	await expect(secondLink).toBeFocused();
});

test("a recovered child id enters the canonical anchored child workspace", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Recovered source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await authenticate(page, "ana", baseURL!);
	await page.goto(`/channels/${child.id}`);

	await expect(page).toHaveURL(url => url.pathname === child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(parent).toBeVisible();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	// With no saved preference, Chat starts open in the parent; the child never mounts one.
	await expect(surface.getByRole("complementary", { name: "Chat" })).toHaveCount(0);
	await expect(parent.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Return to / })).toHaveCount(0);
	// Zoom puts the child at the end of the root's title bar path.
	await expect(titleBar(page, room).getByRole("group", { name: `Document: ${childTitle}` }))
		.toBeVisible();

	let editor = surface.getByRole("textbox", { name: "editable markdown", exact: true });
	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await expect(surface.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);

	await returnToRoot(page, room);
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
	await expect(surface).toHaveCount(0);
});

test("a channel link opens one parent room that a child opens and closes over", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Channel link child ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	let recorded = await recordRoomMounts(page);
	await authenticate(page, "ana", baseURL!);
	await page.goto(`/channels/${room}`);

	let parentPath = `/documents/octo-org/score/test-${room.slice(0, 8)}`;
	await expect(page).toHaveURL(url => url.pathname === parentPath);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(parent.locator("[data-plan-synced]")).toBeAttached();
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url => url.pathname === parentPath);
	await expect(surface).toHaveCount(0);

	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	expect((await recorded.mounts()).filter(entry => entry.endsWith(room))).toEqual([
		`mount ${room}`,
	]);
	expect(recorded.reads(room)).toBe(1);
});

test("a child load failure preserves its mounted parent through back and retry", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Unreliable source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await join("ana");
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	let attempts = 0;
	await page.route(
		`**/api/repositories/octo-org/score/documents/${child.slug}`,
		async route => {
			attempts += 1;
			if (attempts <= 2) {
				await route.fulfill({
					body: JSON.stringify({ error: "Child temporarily unavailable" }),
					contentType: "application/json",
					status: 503,
				});
				return;
			}
			await route.continue();
		},
	);
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });

	await childLink.click();
	let surface = page.locator(".anchored-child-card");
	await expect(surface).toContainText("Couldn't open this document");
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await expect(rootSheet(page, room).locator('[data-document-view="plan"]'))
		.toHaveAttribute("inert", "");
	await returnToRoot(page, room);
	await expect(surface).toHaveCount(0);
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");

	await childLink.click();
	await expect(surface).toContainText("Couldn't open this document");
	await surface.getByRole("button", { name: "Try again" }).click();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
});

test("a direct compact child fills the canvas and reduces motion to a crossfade", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `A substantially longer source review title ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	// A narrow touch-capable window with a fine primary pointer: the compact, non-phone chrome.
	await installPointerMedia(page, { coarse: true, primaryCoarse: false });
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	let stack = page.getByRole("navigation", { name: "Document stack" });
	await expect(stack.getByText(childTitle, { exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(surface.getByRole("navigation", { name: "Workspace view" })).toHaveCount(0);
	let rootNavigation = page.locator(
		`[data-workspace-room="${room}"] > nav[aria-label="Workspace view"]`,
	);
	await rootNavigation.getByRole("button", { name: /^Chat/ }).click();
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(surface).toBeHidden();
	await rootNavigation.getByRole("button", { name: "Document", exact: true }).click();
	await expect(surface).toBeVisible();
	let projects = page.getByRole("button", { name: "Show sidebar" });
	await projects.click();
	let drawer = page.getByRole("dialog", { name: "Projects" });
	await expect(drawer).toBeVisible();
	await drawer.getByRole("link", { name: childTitle, exact: true }).click();
	await expect(drawer).toBeHidden();
	await expect(surface).toBeVisible();
	let parentHeader = page.locator('[data-workspace-surface="document"] .room-header');
	await expect(page.locator(".room-header:visible")).toHaveCount(1);
	await expect(surface.locator(".room-header")).toBeHidden();
	await expect(parentHeader.getByRole("button", { name: /^Return to / })).toHaveCount(0);
	await expect(parentHeader).not.toContainText(childTitle);
	let stackBox = (await stack.boundingBox())!;
	let stackedCard = (await surface.boundingBox())!;
	expect(stackedCard.y).toBeGreaterThanOrEqual(stackBox.y + stackBox.height - 1);
	expect(await surface.evaluate(element => getComputedStyle(element).animationName))
		.toBe("anchored-child-fade");
	await expect(surface.locator(".anchored-child-title")).toBeHidden();
	let headerBox = await parentHeader.boundingBox();
	let childBox = await surface.boundingBox();
	expect(headerBox).not.toBeNull();
	expect(childBox).not.toBeNull();
	expect(childBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
	// The card fills the root sheet's width and fades in place; it does not travel.
	let sheetBox = (await rootSheet(page, room).boundingBox())!;
	let geometry = await surface.evaluate(element => {
		let box = element.getBoundingClientRect();
		return { left: box.left, right: box.right, transform: getComputedStyle(element).transform };
	});
	expect(geometry).toEqual({
		left: sheetBox.x,
		right: sheetBox.x + sheetBox.width,
		transform: "none",
	});

	await returnToRoot(page, room);
	await expect(surface).toHaveCSS("animation-name", "anchored-child-fade-out");
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});

test("Escape in a child editor dismisses the innermost thing before the sheet", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let title = `Escape source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		title,
		CHILD_SOURCE,
	);
	await join("ana");
	await page.goto(child.path);
	let surface = page.getByRole("region", { name: `Child document: ${title}` });
	let editor = surface.getByRole("textbox", { name: "editable markdown", exact: true });
	await expect(editor).toBeVisible();

	await surface.getByRole("heading", { level: 1 }).click();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/");
	let menu = page.getByRole("listbox", { name: "Insert block" });
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(surface).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(surface).toBeVisible();
	await expect(editor).not.toBeFocused();
	await expect(surface).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(surface).toHaveCount(0);
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});

test("split Zoom renames the child from the title bar and keeps the caret on its title", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Zoom rename ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	let bar = titleBar(page, room);
	let root = bar.getByRole("group", { name: `Document: Test ${room.slice(0, 8)}`, exact: true });
	let child = bar.getByRole("group", { name: `Document: ${childTitle}`, exact: true });
	await expect(child).toBeVisible();
	// The child's title sits beside the root's, not inside it.
	await expect(root.getByRole("group")).toHaveCount(0);
	// One Back stop for the keyboard: the root crumb, named for where it goes.
	await expect(bar.getByRole("button", { name: /^Back to / })).toHaveCount(1);
	await expect(bar.locator(".document-title-back")).toHaveAttribute("tabindex", "-1");

	let renamed = `Renamed ${room.slice(0, 8)}`;
	await child.getByRole("button", { name: `Rename ${childTitle}` }).click();
	let field = page.getByRole("textbox", { name: "Document title" });
	await expect(field).toBeFocused();
	await field.fill(renamed);
	await field.press("Enter");
	await expect(field).toHaveCount(0);
	// The rename rekeys the child's card; the remounted title takes the caret back.
	await expect(bar.getByRole("button", { name: `Rename ${renamed}` })).toBeFocused();
});

test("split Zoom off Document makes the child a crumb back to it, not a rename", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Zoom off Document ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let sheet = rootSheet(page, room);
	await sheet.locator("[data-document-toolbar]").getByRole("button", { name: /^Decisions/ })
		.click();
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(sheet.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(surface).toBeHidden();
	let bar = titleBar(page, room);
	await expect(bar.getByRole("button", { name: `Rename ${childTitle}` })).toHaveCount(0);
	let crumb = bar.getByRole("button", { name: childTitle, exact: true });
	await expect(crumb).toHaveAttribute("aria-current", "page");
	await crumb.click();
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	await expect(bar.getByRole("button", { name: `Rename ${childTitle}` })).toBeVisible();
});

test("compact Zoom keeps an open child across root view switches without remounting it", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Zoomed source ${room.slice(0, 8)}`;
	let long = `${CHILD_SOURCE}\n${
		Array.from({ length: 30 }, (_, i) => `Child passage ${i + 1}.`).join("\n\n")
	}\n`;
	let child = await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, long);
	let mounts = await recordRoomMounts(page);
	// Split folds the root's views away under a Zoom child; compact keeps its view navigation.
	await page.setViewportSize({ width: 600, height: 844 });
	await join("ana");
	await page.goto(child.path);
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	let stack = page.getByRole("navigation", { name: "Document stack" });
	await expect(surface).toBeVisible();
	await expect(stack.getByText(childTitle, { exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	let scroller = surface.locator("[data-plan-scroll]");
	// A scroll set while the child is still loading or growing can be reset, so set it until it holds.
	await expect.poll(() =>
		scroller.evaluate(element => {
			element.scrollTop = 120;
			return element.scrollTop;
		})
	).toBe(120);
	let tabs = page.locator(`[data-workspace-room="${room}"] > nav[aria-label="Workspace view"]`);
	await tabs.getByRole("button", { name: /^Decisions/ }).click();
	await expect(surface).toBeHidden();
	// The stack bar stays in sight off Document, so the open child is never lost.
	await expect(stack).toBeVisible();
	// Decisions shows the root's decisions while the child stays open underneath.
	await expect(rootSheet(page, room).locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(page.locator(`[data-workspace-room="${child.id}"] [data-document-view="decisions"]`))
		.toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(stack).toBeVisible();
	await stack.getByRole("button", { name: childTitle, exact: true }).click();
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	await expect(tabs.getByRole("button", { name: /^Document/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(120);
	expect((await mounts.mounts()).filter(entry => entry === `mount ${child.id}`)).toHaveLength(1);

	// Back from another view still returns to the root, which keeps that view.
	await tabs.getByRole("button", { name: /^Decisions/ }).click();
	await stack.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(rootSheet(page, room).locator('[data-document-view="decisions"]')).toBeVisible();
});
