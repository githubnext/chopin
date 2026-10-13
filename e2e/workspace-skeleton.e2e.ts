/**
 * The desktop workspace paints its shape while its code and its document load. The skeleton's
 * sheet, bars and Chat column sit where the loaded workspace puts them, so nothing jumps.
 */

import { authenticate, expect, ready, roomPath, test } from "./room";
import { RESPONSIVE_SOURCE } from "./responsive";

import type { Locator, Page } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };
type Part = "sheet" | "title" | "views" | "chat" | "header" | "tabs" | "frame";

async function box(locator: Locator): Promise<Box> {
	let value = await locator.boundingBox();
	expect(value).not.toBeNull();
	return value!;
}

function expectSameBox(actual: Box, expected: Box, label: string) {
	for (let key of ["x", "y", "width", "height"] as const) {
		expect(Math.abs(actual[key] - expected[key]), `${label} ${key}`).toBeLessThanOrEqual(1);
	}
}

const SKELETON: Record<Part, string> = {
	sheet: ".workspace-skeleton .workspace-document-panel",
	title: ".workspace-skeleton-title",
	views: ".workspace-skeleton-views",
	chat: ".workspace-skeleton .workspace-chat-body",
	header: ".workspace-skeleton .room-header",
	tabs: ".workspace-skeleton-tabs",
	frame: ".workspace-skeleton .workspace-frame",
};

const LOADED: Record<Part, string> = {
	sheet: "main.workspace-document-panel",
	title: "[data-document-title-bar]",
	views: "[data-document-toolbar]",
	chat: "aside.workspace-chat-panel .workspace-chat-body",
	header: ".workspace-header-slot .room-header",
	tabs: "nav.workspace-navigation",
	frame: ".workspace-root:not(.workspace-skeleton) .workspace-frame",
};

async function measure(page: Page, selectors: Record<Part, string>, parts: Part[]) {
	let boxes = new Map<Part, Box>();
	for (let part of parts) boxes.set(part, await box(page.locator(selectors[part]).first()));
	return boxes;
}

const CASES = [
	{
		name: "split",
		viewport: { width: 1440, height: 900 },
		parts: ["sheet", "title", "views", "chat"] as Part[],
	},
	{
		name: "split with Chat closed",
		viewport: { width: 1440, height: 900 },
		chat: "false",
		parts: ["sheet", "title", "views"] as Part[],
	},
	{
		name: "compact",
		viewport: { width: 390, height: 844 },
		parts: ["header", "tabs", "frame"] as Part[],
	},
];

for (let { chat, name, parts, viewport } of CASES) {
	test(`the ${name} skeleton holds the loaded workspace's geometry`, async ({ baseURL, browser, room, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let context = await browser.newContext({ baseURL, viewport });
		try {
			let page = await context.newPage();
			await authenticate(page, "ana", baseURL!);
			if (chat) {
				await page.addInitScript(value => {
					localStorage.setItem("chopin:pane:chat:choice", value);
				}, chat);
			}
			// Hold the workspace's code, then its document, so each loading stage stays on screen.
			let releaseCode!: () => void;
			let code = new Promise<void>(resolve => (releaseCode = resolve));
			await page.route(/\/assets\/(document-route-view|room-workspace)-[^/]*\.js$/, async route => {
				await code;
				await route.continue();
			});
			let releaseSocket!: () => void;
			let socket = new Promise<void>(resolve => (releaseSocket = resolve));
			await page.routeWebSocket(/\/ws(\?.*)?$/, async ws => {
				await socket;
				ws.connectToServer();
			});
			await page.goto(roomPath(room));

			let skeleton = page.locator(".workspace-skeleton");
			await expect(skeleton).toBeVisible();
			await expect(skeleton.getByRole("status")).toHaveText("Opening document…");
			let heading = skeleton.locator(".phone-skeleton-heading");
			await expect(heading).toBeVisible();
			let shell = await measure(page, SKELETON, parts);
			let lines = await box(heading);
			await expect(skeleton.locator(".workspace-chat-panel")).toHaveCount(
				name === "split" ? 1 : 0,
			);

			// The workspace mounts before its document arrives, with the same lines in the column.
			releaseCode();
			await expect(skeleton).toHaveCount(0);
			let preface = page.locator("[data-plan-scroll] .plan-preface .phone-skeleton-heading");
			await expect(preface).toBeVisible();
			let mounted = await measure(page, LOADED, parts);
			for (let part of parts) expectSameBox(mounted.get(part)!, shell.get(part)!, part);
			expectSameBox(await box(preface), lines, "document lines");

			releaseSocket();
			await ready(page);
			await expect(preface).toHaveCount(0);
			await expect(page.locator(".plan-content h1").first()).toBeVisible();
			let loaded = await measure(page, LOADED, parts);
			for (let part of parts) expectSameBox(loaded.get(part)!, shell.get(part)!, part);
		} finally {
			await context.close();
		}
	});
}

test("a split workspace notice rises to the sheet's top margin, with no header row above it", async ({ baseURL, browser, room, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	try {
		let page = await context.newPage();
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);
		let sheet = await box(page.locator(LOADED.sheet));

		await page.goto("/documents/nobody/nothing");
		let title = page.getByRole("heading", { name: "nobody/nothing isn't one of your projects" });
		await expect(title).toBeVisible();
		await expect(page.locator(".room-header")).toHaveCount(0);
		let notice = await box(title.locator(".."));
		expect(Math.abs(notice.y - sheet.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(notice.y + notice.height - (sheet.y + sheet.height))).toBeLessThanOrEqual(1);
	} finally {
		await context.close();
	}
});
