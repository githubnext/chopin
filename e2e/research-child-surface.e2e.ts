import { seedChildChannel } from "./database";
import { installPointerMedia } from "./pointer-media";
import { authenticate, expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PARENT_SOURCE = `# Parent document

${Array.from({ length: 36 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

const CHILD_SOURCE = `# Source review

This ordinary child has its own editable document, Decisions, and inline comments.
`;

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

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
	let parentHeader = parent.locator(".room-header");
	let parentPaper = parent.locator(".workspace-frame");
	await expect(page.locator(".room-header:visible")).toHaveCount(1);
	await expect(parentHeader.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }))
		.toHaveCount(0);
	await expect(parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }))
		.toBeVisible();
	await expect(parentHeader.getByText(childTitle, { exact: true })).toBeVisible();
	await expect(parentHeader.getByRole("group", { name: /People here:/ })).toBeVisible();
	await expect(parentPaper).toHaveAttribute("inert", "");
	await expect(parentPaper).toHaveAttribute("aria-hidden", "true");
	await expect(parentPaper).toHaveCSS("filter", "blur(3px)");
	await expect(parentPaper).toHaveCSS("opacity", "0.68");
	await expect(surface.locator(".room-header")).toBeHidden();
	await surface.evaluate(async element => {
		await Promise.all(element.getAnimations().map(animation => animation.finished));
	});
	let parentBox = await parentPaper.boundingBox();
	let childBox = await surface.boundingBox();
	let headerBox = await parentHeader.boundingBox();
	expect(parentBox).not.toBeNull();
	expect(childBox).not.toBeNull();
	expect(headerBox).not.toBeNull();
	expect(childBox!.x).toBeGreaterThan(parentBox!.x);
	expect(childBox!.y).toBeGreaterThan(parentBox!.y);
	expect(childBox!.x + childBox!.width).toBeLessThan(parentBox!.x + parentBox!.width);
	expect(childBox!.y + childBox!.height).toBeLessThan(parentBox!.y + parentBox!.height);
	expect(childBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 12);
	expect(await surface.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");

	let childClose = surface.getByRole("button", { name: `Close ${childTitle}`, exact: true });
	let childChatToggle = surface.getByRole("button", {
		name: "Show chat pane",
		exact: true,
	});
	await expect(childChatToggle).toBeVisible();
	let closeHandle = await childClose.elementHandle();
	expect(closeHandle).not.toBeNull();
	expect(
		await childChatToggle.evaluate(
			(toggle, close) => toggle.nextElementSibling === close,
			closeHandle,
		),
	).toBe(true);
	let chatToggleBox = await childChatToggle.boundingBox();
	let childCloseBox = await childClose.boundingBox();
	expect(chatToggleBox).not.toBeNull();
	expect(childCloseBox).not.toBeNull();
	expect(chatToggleBox!.x + chatToggleBox!.width)
		.toBeLessThanOrEqual(childCloseBox!.x);

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

	await childClose.click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("a child isolates chat and decisions across every parent-owned close path", async ({ baseURL, join, page, room, seed }) => {
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
	let parentChat = parent.getByRole("complementary", {
		name: "Chat",
		includeHidden: true,
	});
	let parentRoomMessage = `Parent room message ${room.slice(0, 8)}`;
	let parentDraft = parentChat.getByPlaceholder("Use @chopin to ask Chopin");
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
	let parentHeader = parent.locator(".room-header");
	let childClose = surface.getByRole("button", { name: `Close ${childTitle}`, exact: true });
	let childChatToggle = surface.getByRole("button", {
		name: "Show chat pane",
		exact: true,
	});
	let childChat = surface.getByRole("complementary", { name: "Chat" });
	await expect(childChatToggle).toBeVisible();
	await expect(childChat).toBeHidden();

	await childChatToggle.click();
	await expect(childChat).toBeVisible();
	await expect(childChat).not.toContainText(parentRoomMessage);
	await expect(parentChat).toContainText(parentRoomMessage);
	let childRoomMessage = `Child room message ${room.slice(0, 8)}`;
	let childPlannerMessage = `@chopin Child Planner message ${room.slice(0, 8)}`;
	let childPlannerTranscript = childPlannerMessage.replace("@chopin ", "");
	let childDraft = childChat.getByPlaceholder("Use @chopin to ask Chopin");
	await childDraft.fill(childRoomMessage);
	await childChat.getByRole("button", { name: "Send message" }).click();
	await expect(childChat.getByText(childRoomMessage, { exact: true })).toBeVisible();
	await expect.poll(chatSends).toContainEqual({
		channelId: child.id,
		text: childRoomMessage,
		to: "room",
	});
	await childDraft.fill(childPlannerMessage);
	await childChat.getByRole("button", { name: "Send message" }).click();
	await expect(childChat.getByText(childPlannerTranscript, { exact: true })).toBeVisible();
	await expect.poll(chatSends).toContainEqual({
		channelId: child.id,
		text: childPlannerMessage,
		to: "planner",
	});
	await expect(parentChat).not.toContainText(childRoomMessage);
	await expect(parentChat).not.toContainText(childPlannerTranscript);
	await childChat.getByRole("button", {
		name: "Hide chat pane",
		exact: true,
	}).click();
	await expect(childChat).toBeHidden();

	let childEditor = surface.getByRole("textbox", { name: "editable markdown" });
	await childEditor.locator("p").first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true })
		.evaluate(button => (button as HTMLButtonElement).click());
	let commentDraft = page.getByRole("dialog", { name: "New comment" });
	await expect(commentDraft.getByPlaceholder("Comment on this passage…")).toBeFocused();
	await commentDraft.getByRole("button", { name: "Cancel" }).click();
	await expect(commentDraft).toHaveCount(0);
	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent).toContainText("Parent passage 36.");

	await childClose.evaluate(button => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await page.waitForTimeout(250);
	await expect(page).toHaveURL(url => url.pathname === child.path.replace(/\/children\/.*$/, ""));
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(
		parentScrollTop,
	);
	await expect(parentChat).toContainText(parentRoomMessage);

	await childLink.click();
	await expect(surface).toBeVisible();
	await expect(childChatToggle).toBeVisible();
	await expect(childChat).toBeHidden();
	await childChatToggle.click();
	await expect(childChat).not.toContainText(parentRoomMessage);
	await expect(parentChat).toContainText(parentRoomMessage);
	await expect(childChat.getByText(childRoomMessage, { exact: true })).toBeVisible();
	await expect(childChat.getByText(childPlannerTranscript, { exact: true })).toBeVisible();
	await childChat.getByRole("button", {
		name: "Hide chat pane",
		exact: true,
	}).click();
	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	let headerBox = await parentHeader.boundingBox();
	let surfaceBox = await surface.boundingBox();
	let backdrop = page.locator("[data-child-backdrop]");
	let backdropBox = await backdrop.boundingBox();
	let sidebarBox = await sidebar.boundingBox();
	expect(headerBox).not.toBeNull();
	expect(surfaceBox).not.toBeNull();
	expect(backdropBox).not.toBeNull();
	expect(sidebarBox).not.toBeNull();
	expect(backdropBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
	expect(backdropBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
	await page.mouse.click(surfaceBox!.x - 6, surfaceBox!.y + 20);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
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
		localStorage.setItem("chopin:pane:chat:open", "true");
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
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("inert", "");
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("aria-hidden", "true");
	let childChatToggle = surface.getByRole("button", {
		name: "Show chat pane",
		exact: true,
	});
	let childChat = surface.getByRole("complementary", { name: "Chat" });
	await expect(childChatToggle).toBeVisible();
	await expect(childChat).toBeHidden();
	await expect(parentChat).toBeVisible();
	await expect(surface.getByRole("button", { name: "Decisions", exact: true })).toBeVisible();
	await expect(surface.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.getByRole("button", { name: "Tasks & Progress", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(surface.locator('[data-document-view="plan"]')).toBeVisible();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeHidden();
	await childChatToggle.click();
	await expect(childChat).toBeVisible();
	await expect(parentChat).toBeVisible();
	await childChat.getByRole("button", {
		name: "Hide chat pane",
		exact: true,
	}).click();
	await expect(childChat).toBeHidden();
	await expect(parentChat).toBeVisible();

	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent.locator('[data-document-view="decisions"]')).toBeHidden();
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	await expect(childChatToggle).toBeVisible();

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
	await expect(childChatToggle).toBeVisible();
	await expect(childChat).toBeHidden();
	await expect(parentChat).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await parent.locator(".room-header")
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
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
	await surface.getByRole("textbox", { name: "editable markdown" })
		.getByText(passage, { exact: true })
		.selectText();
	await surface.getByRole("button", { name: "Comment on this passage", exact: true }).click();

	let draft = surface.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this child passage.");
	await draft.getByRole("button", { name: "Comment", exact: true }).click();
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
	await expect(page.locator(".anchored-child-surface")).toContainText("Opening child document...");

	release();
	let secondSurface = page.getByRole("region", { name: `Child document: ${secondTitle}` });
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await expect(secondSurface).toBeFocused();
	await page.locator(`[data-workspace-room="${room}"] .room-header`)
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
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
	await page.locator(`[data-workspace-room="${room}"] .room-header`)
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
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
	await expect(surface.getByRole("button", {
		name: "Show chat pane",
		exact: true,
	})).toBeVisible();
	await expect(surface.getByRole("complementary", { name: "Chat" })).toBeHidden();
	let close = surface.getByRole("button", { name: `Close ${childTitle}`, exact: true });
	await expect(close).toBeVisible();
	await expect(
		parent.locator(".room-header").getByRole("button", {
			name: `Return to Test ${room.slice(0, 8)}`,
			exact: true,
		}),
	).toBeVisible();

	let editor = surface.getByRole("textbox", { name: "editable markdown", exact: true });
	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await expect(surface.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);

	await close.click();
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
	await expect(surface).toHaveCount(0);
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
	let surface = page.locator(".anchored-child-surface");
	await expect(surface).toContainText("Cannot open Chopin");
	await expect(surface).toContainText("Child temporarily unavailable");
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("inert", "");
	await parent.locator(".room-header")
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");

	await childLink.click();
	await expect(surface).toContainText("Child temporarily unavailable");
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
	let navigation = surface.getByRole("navigation", { name: "Workspace view" });
	let destinations = navigation.getByRole("button");
	await expect(destinations).toHaveCount(3);
	await expect(navigation.getByRole("button", { name: /^Chat/ })).toBeVisible();
	await expect(navigation.getByRole("button", { name: "Document", exact: true })).toBeVisible();
	await expect(navigation.getByRole("button", { name: /^Decisions/ })).toBeVisible();
	await navigation.getByRole("button", { name: /^Chat/ }).click();
	await expect(surface.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(surface.locator('[data-document-view="plan"]')).toBeHidden();
	await navigation.getByRole("button", { name: "Document", exact: true }).click();
	await expect(surface.getByRole("complementary", { name: "Chat" })).toBeHidden();
	await expect(surface.locator('[data-document-view="plan"]')).toBeVisible();
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	await projects.click();
	let drawer = page.getByRole("dialog", { name: "Projects" });
	await expect(drawer).toBeVisible();
	await drawer.getByRole("link", { name: childTitle, exact: true }).click();
	await expect(drawer).toBeHidden();
	await expect(surface).toBeVisible();
	let parentHeader = page.locator('[data-workspace-surface="document"] .room-header');
	await expect(page.locator(".room-header:visible")).toHaveCount(1);
	await expect(parentHeader.getByText(childTitle, { exact: true })).toBeVisible();
	await expect(surface.locator(".room-header")).toBeHidden();
	await expect(parentHeader.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }))
		.toHaveCount(0);
	await expect(parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }))
		.toBeVisible();
	let childCrumb = parentHeader.getByText(childTitle, { exact: true });
	let members = parentHeader.getByRole("group", { name: /People here:/ });
	await expect(childCrumb).toHaveCSS("text-overflow", "ellipsis");
	let crumbBox = await childCrumb.boundingBox();
	let membersBox = await members.boundingBox();
	expect(crumbBox).not.toBeNull();
	expect(membersBox).not.toBeNull();
	expect(crumbBox!.x + crumbBox!.width).toBeLessThanOrEqual(membersBox!.x);
	let parentPaper = page.locator('[data-workspace-surface="document"] .workspace-frame');
	await expect(parentPaper).toHaveCSS("transform", "none");
	await expect(parentPaper).toHaveCSS("transition-property", "none");
	let headerBox = await parentHeader.boundingBox();
	let childBox = await surface.boundingBox();
	expect(headerBox).not.toBeNull();
	expect(childBox).not.toBeNull();
	expect(Math.round(childBox!.y)).toBe(Math.round(headerBox!.y + headerBox!.height));
	let geometry = await surface.evaluate(element => {
		let style = getComputedStyle(element);
		let box = element.getBoundingClientRect();
		return {
			animationName: style.animationName,
			left: box.left,
			right: innerWidth - box.right,
			transform: style.transform,
		};
	});
	expect(geometry).toEqual({
		animationName: "anchored-child-fade",
		left: 0,
		right: 0,
		transform: "none",
	});

	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCSS("animation-name", "anchored-child-fade-out");
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});
