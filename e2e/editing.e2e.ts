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
	await expect(page.locator('[aria-live="polite"][data-level]')).toHaveAttribute(
		"data-level",
		"notice",
	);

	// The client retries on its own; nothing here reconnects it. Opening is
	// driven by the connection rather than by the mount, and a socket that
	// comes back without re-opening the document would leave the editor
	// unlocked over a plan quietly short of everyone else's edits.
	await ready(page);
	expect(sockets.length).toBeGreaterThan(1);
	await expect(content(page)).toContainText("Before the wire went.");
});

test("Tab leaves a heading instead of indenting it", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("# Title");
	let heading = content(page).getByRole("heading", { level: 1 });
	await expect(heading).toHaveText("Title");

	// A keyboard user has to be able to get past the editor, and trying to
	// must not edit a document everyone else is reading.
	await page.keyboard.press("Tab");
	await expect(content(page)).not.toBeFocused();
	await expect(heading).toHaveText("Title");
	await expect(heading).not.toHaveAttribute("style", /padding/);
	await written(page, room, /^# Title\s*$/);
});

test("Tab nests a list item and Shift+Tab brings it back", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("- one\ntwo");
	await written(page, room, /^- one\n- two$/m);

	// From the end of the item, not only its start.
	await page.keyboard.press("Tab");
	await expect(content(page).locator("li li")).toHaveText("two");
	await expect(content(page)).toBeFocused();
	await written(page, room, /^- one\n {2}- two$/m);

	await page.keyboard.press("Shift+Tab");
	await expect(content(page).locator("li li")).toHaveCount(0);
	await written(page, room, /^- one\n- two$/m);
});

test("Tab on a first list item leaves without a phantom indent", async ({ join, room }) => {
	let ana = await join("ana");
	let ben = await join("ben");

	await content(ana).click();
	await ana.keyboard.type("- one");
	await written(ana, room, /^- one$/m);
	let before = await content(ana).innerHTML();

	// Lexical would nest it inside an empty item of its own, which the source
	// cannot show but every collaborator would.
	await ana.keyboard.press("Tab");
	await expect(content(ana)).not.toBeFocused();
	expect(await content(ana).innerHTML()).toBe(before);

	// A later edit from the same author is the barrier: once Ben has it, he
	// has everything Ana sent before it.
	await content(ana).getByText("one", { exact: true }).click();
	await ana.keyboard.press("End");
	await ana.keyboard.type("!");
	await expect(content(ben).getByRole("listitem")).toHaveText(["one!"]);
	await expect(content(ben).locator("li li")).toHaveCount(0);
	await written(ana, room, /^- one!$/m);
});

test("Tab indents code, Shift+Tab outdents, and Escape then Tab leaves", async ({ join, room }) => {
	let page = await join("ana");
	let hint = content(page).getByText("Esc then Tab to leave");

	await content(page).click();
	await page.keyboard.type("/code");
	await page.getByRole("listbox", { name: "Insert block" }).getByRole("option", {
		name: "Code block",
	})
		.click();
	await page.keyboard.type("a();");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Tab");
	await page.keyboard.type("b();");
	await written(page, room, /^a\(\);\n\tb\(\);$/m);
	await expect(hint).toBeVisible();

	await page.keyboard.press("Shift+Tab");
	await expect(content(page)).toBeFocused();
	await written(page, room, /^a\(\);\nb\(\);$/m);

	await page.keyboard.press("Escape");
	await page.keyboard.press("Tab");
	await expect(content(page)).not.toBeFocused();
	await expect(hint).toBeHidden();
	await written(page, room, /^a\(\);\nb\(\);$/m);
});

test("Tab moves between table cells and out of the last one", async ({ join, room, seed }) => {
	await seed("| Item | Note |\n| ---- | ---- |\n| one  | a    |\n\nAfter.\n");
	let page = await join("ana");

	await content(page).getByText("one", { exact: true }).click();
	await page.keyboard.press("End");
	await page.keyboard.type("1");
	await page.keyboard.press("Tab");
	await page.keyboard.type("2");
	await written(page, room, /one1\s*\|\s*a2/);

	// The last cell hands the caret to the block after the table.
	await page.keyboard.press("Tab");
	await expect(content(page)).toBeFocused();
	await page.keyboard.type("3");
	await written(page, room, /^(3After\.|After\.3)$/m);
	await written(page, room, /one1\s*\|\s*a2\s*\|/);
});

test("Tab over a selection from a list into a paragraph leaves it alone", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("- one\ntwo\n\nafter");
	await written(page, room, /^- one\n- two\n\nafter$/m);

	await page.keyboard.press("Shift+ArrowUp");
	await expect.poll(() => page.evaluate(() => getSelection()?.isCollapsed)).toBe(false);
	// Lexical reads the selection on `selectionchange`, a task after the key.
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
	let before = await content(page).innerHTML();

	await page.keyboard.press("Tab");
	await expect(content(page)).not.toBeFocused();
	expect(await content(page).innerHTML()).toBe(before);
	await written(page, room, /^- one\n- two\n\nafter$/m);
});
