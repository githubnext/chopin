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

/** Lift's peeking tab row in split, or the stack bar's Back in compact. Both return to the root. */
async function returnToRoot(page: Page, room: string) {
	let back = page.getByRole("navigation", { name: "Document stack" })
		.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` });
	let rowReturn = rootSheet(page, room).locator("[data-document-toolbar]")
		.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` });
	await expect(back.or(rowReturn)).toBeVisible();
	if (await back.isVisible()) await back.click();
	else {
		// Click an empty stretch of the peeking row: tab buttons switch views, not just return.
		let tabs = rootSheet(page, room).locator("[data-document-toolbar]");
		let gap = await tabs.evaluate(row => {
			let box = row.getBoundingClientRect();
			for (let x = box.left + 4; x < box.right; x += 4) {
				let hit = document.elementFromPoint(x, box.top + box.height / 2);
				if (hit?.classList.contains("workspace-tab-row-return")) return x - box.left;
			}
			return null;
		});
		expect(gap).not.toBeNull();
		await tabs.click({ position: { x: gap!, y: (await tabs.boundingBox())!.height / 2 } });
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

test("a parent-owned child keeps the parent chrome and nested geometry", async ({ baseURL, join, page, room, seed }) => {
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
	await join("ana");
	await page.setViewportSize({ width: 1920, height: 1080 });
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	let childLink = sidebar.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	let sheet = rootSheet(page, room);
	let tabs = sheet.locator("[data-document-toolbar]");
	let parentHeader = parent.locator(".room-header");
	await expect(page.locator(".room-header:visible")).toHaveCount(1);
	await expect(page.locator(".workspace-header-slot")).toBeVisible();
	await expect(parentHeader.getByRole("button", { name: /^Return to / })).toHaveCount(0);
	await expect(parentHeader).not.toContainText(childTitle);
	await expect(sheet.locator("[data-workspace-document-swap]")).toHaveAttribute("inert", "");
	await expect(tabs).not.toHaveAttribute("inert", "");
	await expect(tabs.getByRole("group", { includeHidden: true, name: /People here:/ }))
		.toBeVisible();
	await expect(surface.locator(".anchored-child-title")).toHaveText(childTitle);
	await expect(
		surface.getByRole("button", { name: /^(Document|Decisions|Show chat|Expand document)/ }),
	).toHaveCount(0);
	await expect(surface.locator(".room-header")).toBeHidden();
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	expect(await sheet.evaluate(element => getComputedStyle(element).transform)).not.toBe("none");
	await expect(sheet.locator(".workspace-child-scrim")).toHaveCSS("opacity", "0.45");
	let tabsBox = (await tabs.boundingBox())!;
	let cardBox = (await surface.boundingBox())!;
	let sheetBox = (await sheet.boundingBox())!;
	let headerBox = (await parentHeader.boundingBox())!;
	// The visible header row sits above the expanded parent sheet's tab row.
	expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(tabsBox.y);
	expect(cardBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1);
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

	// 1. The peeking tab row, closed twice in one task: only one close happens.
	await sheet.locator("[data-document-toolbar]")
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

	// 4. A root tab returns and also switches the root's view.
	await reopen();
	await sheet.locator("[data-document-toolbar]").getByRole("button", {
		name: "Decisions",
		exact: true,
	}).click();
	await expect(surface).toHaveCount(0);
	await expect(parent.locator('[data-document-view="decisions"]')).toBeVisible();
	await sheet.locator("[data-document-toolbar]").getByRole("button", {
		name: "Document",
		exact: true,
	}).click();
	await expect(parent.locator('[data-document-view="plan"]')).toBeVisible();
	await reopen();
	await expect(chatSends().filter(send => send.channelId === child.id)).toHaveLength(0);
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

test("Lift keeps the child for the surface toggle and presence, returns for the row and a tab", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Lift source ${room.slice(0, 8)}`;
	await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, CHILD_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let tabs = rootSheet(page, room).locator("[data-document-toolbar]");
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
	await page.keyboard.press("Enter");
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));

	await childLink.click();
	await expect(surface).toBeVisible();
	await tabs.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface).toHaveCount(0);
	await expect(parent.locator('[data-document-view="decisions"]')).toBeVisible();
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
	await expect(sheet.locator("[data-workspace-document-swap]")).toHaveAttribute("inert", "");
	await expect(sheet.locator("[data-document-toolbar]")).not.toHaveAttribute("inert", "");
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
	await expect(parent.locator(".room-header").getByRole("button", { name: /^Return to / }))
		.toHaveCount(0);
	await expect(surface.locator(".anchored-child-title")).toHaveText(childTitle);

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
	await expect(rootSheet(page, room).locator("[data-workspace-document-swap]"))
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
	await installPointerMedia(page, { coarse: true, primaryCoarse: true });
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

test("Zoom keeps an open child across root tab switches without remounting it", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Zoomed source ${room.slice(0, 8)}`;
	let long = `${CHILD_SOURCE}\n${
		Array.from({ length: 30 }, (_, i) => `Child passage ${i + 1}.`).join("\n\n")
	}\n`;
	let child = await seedChildChannel(port(baseURL!), room, crypto.randomUUID(), childTitle, long);
	let mounts = await recordRoomMounts(page);
	await page.addInitScript(() => localStorage.setItem("chopin:dev:child-motion", "zoom"));
	await page.setViewportSize({ width: 1440, height: 900 });
	await join("ana");
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true }).click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	let stack = page.getByRole("navigation", { name: "Document stack" });
	await expect(surface).toBeVisible();
	await expect(stack.getByText(childTitle, { exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	let scroller = surface.locator("[data-plan-scroll]");
	await scroller.evaluate(element => element.scrollTop = 120);
	let tabs = rootSheet(page, room).locator("[data-document-toolbar]");
	await tabs.getByRole("button", { name: /^Decisions/ }).click();
	await expect(surface).toBeHidden();
	await expect(stack).toHaveCount(0);
	// Decisions shows the root's decisions while the child stays open underneath.
	await expect(rootSheet(page, room).locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(page.locator(`[data-workspace-room="${child.id}"] [data-document-view="decisions"]`))
		.toHaveCount(0);
	await page.keyboard.press("Escape");
	await tabs.getByRole("button", { name: /^Document/ }).click();
	await expect(surface).toBeVisible();
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(120);
	expect((await mounts.mounts()).filter(entry => entry === `mount ${child.id}`)).toHaveLength(1);
	await stack.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
});
