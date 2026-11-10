import { authenticate, content, expect, ready, roomPath, test } from "./room";

import type { WebSocketRoute } from "@playwright/test";

test("on a phone, Document's Reconnect has a touch-sized hit area without covering content and can be focused", async ({ baseURL, browser, room, seed }) => {
	test.setTimeout(90_000);
	await seed("# A document with real content\n\nThe first paragraph follows.\n");
	let context = await browser.newContext({
		baseURL,
		deviceScaleFactor: 3,
		hasTouch: true,
		isMobile: true,
		reducedMotion: "reduce",
		viewport: { width: 390, height: 844 },
	});
	let sockets: WebSocketRoute[] = [];
	let offline = false;
	try {
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		await page.routeWebSocket("**/ws?**", socket => {
			if (offline) return socket.close();
			socket.connectToServer();
			sockets.push(socket);
		});
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Document/ }).tap();
		offline = true;
		await sockets.at(-1)!.close();
		let banner = page.locator("[data-document-banner] [data-connection-banner]");
		let reconnect = banner.getByRole("button", { name: "Reconnect", exact: true });
		await expect(reconnect).toBeVisible({ timeout: 40_000 });
		await expect(page.locator("[data-connection-banner]")).toHaveCount(1);
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);

		// Check each point in a 44px square, not merely the styled box: an overlapping element
		// could steal the touch even when the button itself is large enough.
		let hits = await reconnect.evaluate(button => {
			let rect = button.getBoundingClientRect();
			let left = rect.left + rect.width / 2 - 22;
			let top = rect.top + rect.height / 2 - 22;
			let count = 0;
			for (let y = 0; y < 44; y++) {
				for (let x = 0; x < 44; x++) {
					let hit = document.elementFromPoint(left + x + 0.5, top + y + 0.5);
					if (hit && (hit === button || button.contains(hit))) count++;
				}
			}
			return count;
		});
		expect(hits, "all points in the 44×44 target reach Reconnect").toBe(44 * 44);

		let noticeBox = await banner.boundingBox();
		let headingBox = await content(page).locator("h1").first().boundingBox();
		expect(noticeBox).not.toBeNull();
		expect(headingBox).not.toBeNull();
		expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(headingBox!.y);

		// Start at the document body and reach the action by keyboard, not programmatic focus.
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		for (let i = 0; i < 80 && !await reconnect.evaluate(el => el === document.activeElement); i++) {
			await page.keyboard.press("Tab");
		}
		await expect(reconnect).toBeFocused();
	} finally {
		await Promise.all(sockets.map(socket => socket.close()));
		await context.close();
	}
});
