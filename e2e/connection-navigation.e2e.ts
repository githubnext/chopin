/**
 * One banner per cause when the server is out of reach. The page-top navigation error ("Could
 * not reach Chopin") and the Chat connection banner tell one fact, so while the banner tells it
 * the error is quiet, and when the connection returns what failed is asked for again. An error
 * the server answered is another cause and keeps its own notice.
 *
 * The room's socket is proxied, as in connection.e2e.ts, because only the proxy can be the thing
 * that drops it.
 */
import { content, expect, test } from "./room";

import type { Page, WebSocketRoute } from "@playwright/test";

function cuttable(page: Page) {
	let sockets: WebSocketRoute[] = [];
	let state = { offline: false };
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		socket.connectToServer();
		sockets.push(socket);
	});
	return { ready, sockets, state };
}

/** Every banner the page draws: the connection's and a failure's. */
function banners(page: Page) {
	return page.locator("[data-banner]");
}

function navigationNotice(page: Page) {
	return page.locator(".navigation-error");
}

function openDocument(page: Page) {
	return page.getByRole("complementary", { name: "Projects" }).getByRole("link").and(
		page.locator('[aria-current="page"]'),
	);
}

test("a server out of reach is told by the connection banner alone, and the page-top error goes when it returns", async ({ join, page, seed }) => {
	await seed("# A calmer document\n\nOne cause, one banner.\n");
	let wire = cuttable(page);
	await wire.ready;
	let reachable = false;
	await page.route("**/api/navigation", async route => {
		if (route.request().method() === "GET" && !reachable) return route.abort("failed");
		await route.continue();
	});
	await join("ana");

	// The server cannot be reached while the room's socket holds: the error is the only notice.
	await expect(navigationNotice(page)).toContainText("Could not reach Chopin.");
	await expect(banners(page)).toHaveCount(0);

	// The socket goes too: the connection banner takes the loss, and the error does not repeat it.
	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(page.locator("[data-connection-banner]")).toBeVisible();
	await expect(navigationNotice(page)).toHaveCount(0);
	await expect(banners(page)).toHaveCount(1);

	// The server comes back: the banner goes and the navigation it could not fetch is fetched.
	reachable = true;
	wire.state.offline = false;
	await expect(content(page)).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await expect(banners(page)).toHaveCount(0, { timeout: 30_000 });
	await expect(navigationNotice(page)).toHaveCount(0);
	await expect(openDocument(page)).toBeVisible();
});

test("an error the server answered is another cause and stays through the outage and the return", async ({ join, page, seed }) => {
	await seed("# A calmer document\n\nAnother cause, another banner.\n");
	let wire = cuttable(page);
	await wire.ready;
	let answered = true;
	await page.route("**/api/navigation", async route => {
		if (route.request().method() === "GET" && answered) {
			return route.fulfill({ status: 503, json: { error: "Navigation is unavailable." } });
		}
		await route.continue();
	});
	await join("ana");
	await expect(navigationNotice(page)).toContainText("Navigation is unavailable.");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(page.locator("[data-connection-banner]")).toBeVisible();
	await expect(navigationNotice(page)).toContainText("Navigation is unavailable.");

	wire.state.offline = false;
	await expect(content(page)).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await expect(banners(page)).toHaveCount(0, { timeout: 30_000 });
	await expect(navigationNotice(page)).toContainText("Navigation is unavailable.");

	answered = false;
	await navigationNotice(page).getByRole("button", { name: "Try again", exact: true }).click();
	await expect(navigationNotice(page)).toHaveCount(0);
});
