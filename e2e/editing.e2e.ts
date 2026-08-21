/**
 * A keystroke, all the way to the file and back.
 *
 * Every layer between the two is covered somewhere in `bun test` — the dialect
 * round-trips, the room validates, the snapshot writes — and none of those
 * tests can press a key. What is only testable here is that the chain is
 * connected: an editor whose update listener throws keeps accepting edits and
 * sends none of them, which looks exactly like a working editor until you
 * reload.
 */

import { content, expect, ready, test, written } from "./room";

import type { WebSocketRoute } from "@playwright/test";

test("a reload shows what was typed", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("Ship the thing by Friday.");
	await written(page, room, /Ship the thing by Friday\./);

	await page.reload();
	await ready(page);

	await expect(content(page)).toContainText("Ship the thing by Friday.");
});

test("a markdown shortcut becomes the block it names", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("# What we are building\n");
	await page.keyboard.type("A planning surface two people can share.");

	await expect(content(page).getByRole("heading", { level: 1 })).toHaveText(
		"What we are building",
	);

	// The heading has to survive as a heading, not as a paragraph that happens
	// to start with a hash — that is the difference between a document the
	// agent can edit structurally and one it can only append to.
	await written(page, room, /^# What we are building$/m);
	await written(page, room, /^A planning surface two people can share\.$/m);
});

test("losing the connection locks the plan, and getting it back unlocks it", async ({ join, page }) => {
	/*
	 * Routed rather than `context.setOffline`, which leaves an established
	 * socket alone — it governs what may be opened, and by the time there is
	 * anything to disconnect the opening has happened. Proxying the socket is
	 * the only way to be the thing that drops it.
	 */
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		route.connectToServer();
		sockets.push(route);
	});

	await join("ana");

	await content(page).click();
	await page.keyboard.type("Before the wire went.");

	await sockets.at(-1)!.close();

	// Read-only is the point: an editor that keeps taking keystrokes it cannot
	// send is worse than one that stops, because the typing looks like it
	// worked right up until the reload that loses it.
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.locator('[aria-live="polite"]')).toHaveAttribute("data-level", "notice");

	// The client retries on its own; nothing here reconnects it. Opening is
	// driven by the connection rather than by the mount, and a socket that
	// comes back without re-opening the document would leave the editor
	// unlocked over a plan quietly short of everyone else's edits.
	await ready(page);
	expect(sockets.length).toBeGreaterThan(1);
	await expect(content(page)).toContainText("Before the wire went.");
});
