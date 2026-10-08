/**
 * What a dropped connection looks like from the page.
 *
 * Routed rather than `context.setOffline`, which leaves an established socket
 * alone. Proxying the socket is the only way to be the thing that drops it.
 */

import { chatInput, expectChatValue } from "./chat-input";
import { content, expect, ready, status, test } from "./room";

import type { Page, WebSocketRoute } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function route(page: Page) {
	let sockets: WebSocketRoute[] = [];
	let state = { offline: false };
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		socket.connectToServer();
		sockets.push(socket);
	});
	return { sockets, state, ready };
}

test("a blip that recovers inside the grace period shows nothing", async ({ join, page }) => {
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let connection = chat.locator(".composer-connection");
	await expect(connection).toBeEmpty();

	await wire.sockets.at(-1)!.close();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(1);

	// Past the moment the old client raised its alarms, and still quiet.
	let until = Date.now() + 1800;
	while (Date.now() < until) {
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
		await expect(status(page)).toHaveAttribute("data-level", "hidden");
		await expect(connection).toBeEmpty();
		await expect(chat.getByText(/Connection lost|Synchronizing|Reconnecting|Offline/))
			.toHaveCount(0);
		await page.waitForTimeout(150);
	}
});

test("a long outage says so once, keeps the draft, and comes back on the online event", async ({ join, page }) => {
	// The widest jitter, so a scheduled retry cannot pass for the online event.
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let input = chatInput(chat);
	let connection = chat.locator(".composer-connection");
	let composer = await chat.locator(".chat-composer").boundingBox();

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();

	// Still draftable: the composer only holds back the send.
	await input.click();
	await page.keyboard.type("Written while offline");
	await expect(connection).toHaveText("Reconnecting…");
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.locator(".plan[data-plan-offline]")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect(input).toHaveAttribute("contenteditable", "true");
	// Nothing was inserted above the composer to push the transcript.
	await expect(chat.getByText(/Connection lost|Synchronizing/)).toHaveCount(0);
	expect(await chat.locator(".chat-composer").boundingBox()).toEqual(composer);

	await expect(connection).toHaveText("Offline", { timeout: 10_000 });
	await expect(chat.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
	await page.keyboard.type(" and kept");

	wire.state.offline = false;
	let attempts = wire.sockets.length;
	let back = Date.now();
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	expect(wire.sockets.length).toBe(attempts + 1);
	expect(Date.now() - back).toBeLessThan(3000);

	await expect(connection).toBeEmpty();
	await expectChatValue(input, "Written while offline and kept");
	await input.press("Enter");
	await expectChatValue(input, "");
	await expect(chat.getByText("Written while offline and kept", { exact: true })).toBeVisible();
});
