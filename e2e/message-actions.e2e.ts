/**
 * Every Chat message, a person's and the Planner's, has the toolbar: three quick reactions, Add
 * reaction and a menu holding Copy, Copy as plain text and the message's other actions. It shows on
 * hover, on keyboard focus and from a long press on a touch screen; the whole message is shaded
 * while it does. Reactions are kept per message and per person, live for everyone in the room.
 */
import AxeBuilder from "@axe-core/playwright";

import { expect, openIsolatedRoom, test } from "./room";

import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const CLIPBOARD = ["clipboard-read", "clipboard-write"] as const;

const PERSON = {
	id: "message-person",
	text:
		"Please **check** the [rollout docs](https://example.com/rollout) and `bun test`.\n\n- first\n- second",
};
const PLANNER = {
	id: "message-planner",
	text: "I renamed *the section*.\n\n1. one\n2. two",
};

const SPACED = {
	id: "message-spaced",
	text:
		"Spaced  out   words\tand ![alt](https://example.com/p.png) a gap.\n\nSecond  paragraph with <b>html</b>  inside.",
};

const GFM = {
	id: "message-gfm",
	text:
		"Ship ~~draft~~ live and keep ~tilde~.\n\n- [x] build\n- [ ] verify\n\n| Stage | State |\n| - | - |\n| build | ~~red~~ green |",
};

function transcript() {
	return [
		{
			id: PERSON.id,
			author: { kind: "member", handle: "ben" },
			text: PERSON.text,
			ts: 1_700_000_001,
		},
		{ id: PLANNER.id, author: { kind: "agent" }, text: PLANNER.text, ts: 1_700_000_002 },
	];
}

function chatOf(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chatOf(page).locator(`[data-chat-message-id="${id}"]`);
}

function toolbar(message: Locator): Locator {
	return message.getByRole("toolbar", { name: "Reactions and actions" });
}

async function clipboard(page: Page): Promise<string> {
	return page.evaluate(() => navigator.clipboard.readText());
}

async function openMenu(page: Page, target: Locator): Promise<Locator> {
	await target.hover();
	await toolbar(target).getByRole("button", { name: "Message actions" }).click();
	let menu = page.getByRole("menu", { name: "Message actions" });
	await expect(menu).toBeVisible();
	return menu;
}

/** A finger held on the message for longer than the long press, without moving. */
async function longPress(page: Page, target: Locator, offset = { x: 24, y: 8 }): Promise<void> {
	let box = (await target.boundingBox())!;
	let point = { x: box.x + offset.x, y: box.y + offset.y };
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

test("a person's message and the Planner's both show the same toolbar on hover, and nothing else", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	for (let id of [PERSON.id, PLANNER.id]) {
		let target = message(page, id);
		await expect(toolbar(target)).toHaveCSS("opacity", "0");
		await target.hover();
		await expect(toolbar(target)).toHaveCSS("opacity", "1");
		let names = await toolbar(target).getByRole("button").evaluateAll(buttons =>
			buttons.map(button => button.getAttribute("aria-label"))
		);
		expect(names).toEqual([
			"Looks right",
			"Explain this",
			"Not quite",
			"Add reaction",
			"Reply in thread",
			"Message actions",
		]);
		let glyphs = await toolbar(target).getByRole("button").evaluateAll(buttons =>
			buttons.slice(0, 3).map(button => button.textContent)
		);
		expect(glyphs).toEqual(["✅", "❓", "👎"]);
	}
	await chatOf(page).locator("[data-chat-stack]").hover({ position: { x: 1, y: 1 } });
	await expect(toolbar(message(page, PERSON.id))).toHaveCSS("opacity", "0");
});

test("hovering a message shades the whole row in the hover surface, and keeps it while the menu is open", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, PLANNER.id);
	let shade = () =>
		target.evaluate(element => {
			let style = getComputedStyle(element, "::before");
			return { opacity: style.opacity, background: style.backgroundColor };
		});
	expect((await shade()).opacity).toBe("0");

	await target.hover();
	await expect.poll(async () => (await shade()).opacity).toBe("1");
	let hoverSurface = await page.evaluate(() => {
		let probe = document.createElement("div");
		probe.style.backgroundColor = "var(--color-hover)";
		document.body.append(probe);
		let color = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return color;
	});
	expect((await shade()).background).toBe(hoverSurface);
	let reach = await target.evaluate(element => {
		let style = getComputedStyle(element, "::before");
		return { left: parseFloat(style.left), right: parseFloat(style.right) };
	});
	expect(reach.left).toBeLessThanOrEqual(-36);
	expect(reach.right).toBeLessThan(0);
	let pane = (await chatOf(page).boundingBox())!;

	await toolbar(target).getByRole("button", { name: "Message actions" }).click();
	await page.mouse.move(pane.x + 4, pane.y + 4);
	await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
	await expect.poll(async () => (await shade()).opacity).toBe("1");
	await expect(toolbar(target)).toHaveCSS("opacity", "1");

	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(toolbar(target).getByRole("button", { name: "Message actions" })).toBeFocused();
	await expect.poll(async () => (await shade()).opacity).toBe("1");

	await page.mouse.click(pane.x + 4, pane.y + 4);
	await expect.poll(async () => (await shade()).opacity).toBe("0");
	await expect(toolbar(target)).toHaveCSS("opacity", "0");
});

test("Copy writes the Markdown of a person's message and of the Planner's reply exactly, and says Copied for a moment", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	await page.clock.install();
	for (let item of [PERSON, PLANNER]) {
		let menu = await openMenu(page, message(page, item.id));
		let copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
		await expect(menu.getByRole("menuitem")).toHaveText(["Copy", "Copy as plain text"]);
		await copy.click();

		await expect.poll(() => clipboard(page)).toBe(item.text);
		await expect(menu.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Copy as plain text", exact: true }))
			.toBeVisible();
		await expect(message(page, item.id).getByRole("status")).toHaveText("Copied");

		await page.clock.fastForward(1_400);
		await expect(menu.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
		await page.clock.fastForward(200);
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(message(page, item.id).getByRole("status")).toHaveText("");
		await expect(toolbar(message(page, item.id)).getByRole("button", { name: "Message actions" }))
			.toBeFocused();

		let again = await openMenu(page, message(page, item.id));
		await expect(again.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
	}
});

test("Copy as plain text writes the message as the page shows it", async ({ join, seed }) => {
	await seed("# Actions\n", {
		transcript: [
			...transcript(),
			{
				id: SPACED.id,
				author: { kind: "member", handle: "ben" },
				text: SPACED.text,
				ts: 1_700_000_003,
			},
			{
				id: GFM.id,
				author: { kind: "agent" },
				text: GFM.text,
				ts: 1_700_000_004,
			},
		],
	});
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	let menu = await openMenu(page, message(page, PERSON.id));
	await menu.getByRole("menuitem", { name: "Copy as plain text" }).click();
	await expect.poll(() => clipboard(page)).toBe(
		"Please check the rollout docs and bun test.\n\nfirst\nsecond",
	);
	await expect(menu.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();

	let planner = await openMenu(page, message(page, PLANNER.id));
	await planner.getByRole("menuitem", { name: "Copy as plain text" }).click();
	await expect.poll(() => clipboard(page)).toBe("I renamed the section.\n\none\ntwo");

	let spaced = message(page, SPACED.id);
	let drawn = await spaced.locator("[data-chat-message-text]").evaluate(element =>
		(element as HTMLElement).innerText.trim()
	);
	expect(drawn).toBe("Spaced out words and a gap.\n\nSecond paragraph with html inside.");
	let spacedMenu = await openMenu(page, spaced);
	await spacedMenu.getByRole("menuitem", { name: "Copy as plain text" }).click();
	await expect.poll(() => clipboard(page)).toBe(drawn);

	let gfm = message(page, GFM.id);
	await expect(gfm.locator("del")).toHaveText(["draft", "red"]);
	await expect(gfm.getByRole("checkbox", { name: "Task" })).toHaveCount(2);
	await expect(gfm.getByRole("table")).toBeVisible();
	let gfmMenu = await openMenu(page, gfm);
	await gfmMenu.getByRole("menuitem", { name: "Copy as plain text" }).click();
	await expect.poll(() => clipboard(page)).toBe(
		"Ship draft live and keep ~tilde~.\n\nbuild\nverify\n\nStage\tState\nbuild\tred green",
	);
});

test("nothing Chopin draws around a message is copied with it", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	let target = message(page, PERSON.id);
	let menu = await openMenu(page, target);
	await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
	let written = await clipboard(page);
	for (
		let drawn of [
			"Copied",
			"Looks right",
			"Explain this",
			"Not quite",
			"Reply in thread",
			"Sending",
		]
	) {
		expect(written).not.toContain(drawn);
	}
	expect(written).toBe(PERSON.text);
});

test("the toolbar is a keyboard path: one tab stop, arrows within it, Enter opens the menu and its items", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	let target = message(page, PERSON.id);
	let bar = toolbar(target);
	let buttons = bar.getByRole("button");

	await target.getByRole("link", { name: "rollout docs" }).focus();
	await page.keyboard.press("Tab");
	await expect(buttons.nth(0)).toBeFocused();
	await expect(bar).toHaveCSS("opacity", "1");
	await expect(target).toHaveCSS("isolation", "isolate");
	await expect.poll(() => target.evaluate(element => getComputedStyle(element, "::before").opacity))
		.toBe("1");

	await page.keyboard.press("ArrowRight");
	await expect(buttons.nth(1)).toBeFocused();
	await page.keyboard.press("End");
	await expect(buttons.nth(5)).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(buttons.nth(0)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(buttons.nth(5)).toBeFocused();

	await page.keyboard.press("Enter");
	let menu = page.getByRole("menu", { name: "Message actions" });
	await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menu.getByRole("menuitem", { name: "Copy as plain text" })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect.poll(() => clipboard(page)).toBe(PERSON.text);

	await page.keyboard.press("Escape");
	await expect(buttons.nth(5)).toBeFocused();
	await expect(buttons.nth(5)).toHaveAttribute("aria-expanded", "false");
});

test("reacting puts a pill under the message that is yours to take back, and a second person's reaction counts with it", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let ana = await join("ana");
	let ben = await join("ben", {});
	let mine = message(ana, PLANNER.id);
	let theirs = message(ben, PLANNER.id);

	await mine.hover();
	let quick = toolbar(mine).getByRole("button", { name: "Looks right" });
	await expect(quick).toHaveAttribute("aria-pressed", "false");
	await quick.click();

	let pill = mine.getByRole("button", { name: "You reacted with ✅" });
	await expect(pill).toHaveAttribute("aria-pressed", "true");
	await expect(pill).toHaveText("✅1");
	await expect(quick).toHaveAttribute("aria-pressed", "true");
	let seen = theirs.getByRole("button", { name: "Ana reacted with ✅" });
	await expect(seen).toHaveText("✅1");
	await expect(seen).toHaveAttribute("aria-pressed", "false");

	await seen.click();
	await expect(theirs.getByRole("button", { name: "Ana and You reacted with ✅" })).toHaveText(
		"✅2",
	);
	await expect(mine.getByRole("button", { name: "You and Ben reacted with ✅" })).toHaveText("✅2");
	await expect(mine.getByRole("button", { name: "You and Ben reacted with ✅" }))
		.toHaveAttribute("aria-pressed", "true");

	await ana.reload();
	await expect(
		message(ana, PLANNER.id).getByRole("button", { name: "You and Ben reacted with ✅" }),
	)
		.toHaveText("✅2");

	await message(ana, PLANNER.id).getByRole("button", { name: "You and Ben reacted with ✅" })
		.click();
	await expect(message(ana, PLANNER.id).getByRole("button", { name: "Ben reacted with ✅" }))
		.toHaveAttribute("aria-pressed", "false");
	await expect(theirs.getByRole("button", { name: "You reacted with ✅" })).toHaveText("✅1");
	await theirs.getByRole("button", { name: "You reacted with ✅" }).click();
	await expect(mine.getByRole("group", { name: "Reactions" })).toHaveCount(0);
	await expect(theirs.getByRole("group", { name: "Reactions" })).toHaveCount(0);
});

test("the quick reactions are ✅ Looks right, ❓ Explain this and 👎 Not quite, and each is a toggle", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, PERSON.id);
	for (let [emoji, label] of [["✅", "Looks right"], ["❓", "Explain this"], ["👎", "Not quite"]]) {
		await target.hover();
		await toolbar(target).getByRole("button", { name: label, exact: true }).click();
		await expect(target.locator(`[data-chat-reaction="${emoji}"]`)).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	}
	await expect(target.getByRole("group", { name: "Reactions" }).getByRole("button")).toHaveText([
		"✅1",
		"❓1",
		"👎1",
	]);
	await target.hover();
	await toolbar(target).getByRole("button", { name: "Explain this", exact: true }).click();
	await expect(target.locator('[data-chat-reaction="❓"]')).toHaveCount(0);
});

test("Add reaction opens a picker for any emoji: listed, searched, or typed and pasted", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, PERSON.id);
	await target.hover();
	let add = toolbar(target).getByRole("button", { name: "Add reaction" });
	await add.click();
	let picker = page.getByRole("dialog", { name: "Add reaction" });
	let field = picker.getByRole("textbox", { name: "Search emoji, or paste one" });
	await expect(field).toBeFocused();

	await field.fill("party");
	await picker.getByRole("button", { name: "🎉" }).click();
	await expect(picker).toHaveCount(0);
	await expect(add).toBeFocused();
	await expect(target.getByRole("button", { name: "You reacted with 🎉" })).toHaveText("🎉1");

	await add.click();
	await field.fill("zzzzzz");
	await expect(picker.getByRole("status")).toHaveText("No emoji found");
	await field.fill("🇳🇴 flag");
	await field.press("Enter");
	await expect(target.getByRole("button", { name: "You reacted with 🇳🇴" })).toHaveText("🇳🇴1");

	await add.click();
	await field.fill("👨‍👩‍👧‍👦");
	await picker.getByRole("button", { name: "👨‍👩‍👧‍👦" }).click();
	await expect(target.locator('[data-chat-reaction="👨‍👩‍👧‍👦"]')).toHaveText("👨‍👩‍👧‍👦1");

	await add.click();
	await field.press("ArrowDown");
	await expect(picker.getByRole("button").first()).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(picker.getByRole("button").nth(1)).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(picker).toHaveCount(0);
	await expect(add).toBeFocused();
});

test("a reaction the server turns down is not shown, and its message says why: a 21st different emoji from one person, or one that is not a single emoji", async ({ join, seed }) => {
	let twenty = "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙";
	let held = [...new Intl.Segmenter().segment(twenty)].map(part => part.segment);
	expect(held).toHaveLength(20);
	await seed("# Actions\n", {
		transcript: [
			{
				...transcript()[0]!,
				reactions: held.map(emoji => ({ emoji, handles: ["ana"] })),
			},
			transcript()[1]!,
		],
	});
	let ana = await join("ana");
	let ben = await join("ben", {});
	let mine = message(ana, PERSON.id);
	let theirs = message(ben, PERSON.id);
	await expect(mine.locator("[data-chat-reaction]")).toHaveCount(20);
	let refusal = mine.getByRole("status").filter({ hasText: "Couldn't react" });

	await mine.hover();
	await toolbar(mine).getByRole("button", { name: "Add reaction" }).click();
	let picker = ana.getByRole("dialog", { name: "Add reaction" });
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill("party");
	await picker.getByRole("button", { name: "🎉" }).click();
	await expect(refusal).toHaveText(
		"Couldn't react. You can react to a message with at most 20 different emoji.",
	);
	await expect(mine.locator('[data-chat-reaction="🎉"]')).toHaveCount(0);

	// Ben's reaction is told after anything Ana's refused one could have been, so seeing it is the
	// proof that the room was told nothing of hers; and the Chat opened again is what was saved.
	await theirs.hover();
	await toolbar(theirs).getByRole("button", { name: "Looks right" }).click();
	await expect(theirs.getByRole("button", { name: "You reacted with ✅" })).toHaveText("✅1");
	await expect(mine.getByRole("button", { name: "Ben reacted with ✅" })).toHaveText("✅1");
	await expect(theirs.locator('[data-chat-reaction="🎉"]')).toHaveCount(0);
	await ana.reload();
	await expect(mine.locator("[data-chat-reaction]")).toHaveCount(21);
	await expect(mine.locator('[data-chat-reaction="🎉"]')).toHaveCount(0);
	await expect(refusal).toHaveCount(0);

	// Giving one up frees a place, and her next reaction is taken.
	await mine.getByRole("button", { name: "You reacted with 😀" }).click();
	await expect(mine.locator('[data-chat-reaction="😀"]')).toHaveCount(0);
	await mine.hover();
	await toolbar(mine).getByRole("button", { name: "Add reaction" }).click();
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill("party");
	await picker.getByRole("button", { name: "🎉" }).click();
	await expect(mine.getByRole("button", { name: "You reacted with 🎉" })).toHaveText("🎉1");

	// A single cluster too long for an emoji is turned down in the same way, and goes at her next ask.
	await mine.hover();
	await toolbar(mine).getByRole("button", { name: "Add reaction" }).click();
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill(
		"👍" + "\u0301".repeat(40),
	);
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).press("Enter");
	await expect(refusal).toHaveText("Couldn't react. A reaction is a single emoji.");
	await expect(mine.locator("[data-chat-reaction]")).toHaveCount(21);
	await mine.getByRole("button", { name: "You reacted with 🎉" }).click();
	await expect(refusal).toHaveCount(0);
});

test("a reader who cannot edit the document can still react", async ({ baseURL, browser, room, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let context = await browser.newContext({ baseURL });
	try {
		let page = await context.newPage();
		let { authenticate, roomPath } = await import("./room");
		await authenticate(page, `score-reader-${room.slice(0, 8)}`, baseURL!);
		await page.goto(roomPath(room));
		let target = message(page, PERSON.id);
		await expect(target).toBeVisible();
		await target.hover();
		await toolbar(target).getByRole("button", { name: "Looks right" }).click();
		await expect(target.getByRole("button", { name: /reacted with ✅/ })).toHaveText("✅1");
	} finally {
		await context.close();
	}
});

test("on a phone the toolbar comes from a long press, sits above the message, and never covers its text", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
	await page.context().grantPermissions([...CLIPBOARD]);
	let target = message(page, PERSON.id);
	let bar = toolbar(target);

	await expect(bar).toBeHidden();
	await target.tap({ position: { x: 24, y: 8 } });
	await expect(bar).toBeHidden();

	await longPress(page, target);
	await expect(bar).toBeVisible();
	let [barBox, textBox, messageBox] = await Promise.all([
		bar.boundingBox(),
		target.locator("[data-chat-message-text]").boundingBox(),
		target.boundingBox(),
	]);
	expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(messageBox!.y + 1);
	expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(textBox!.y + 1);
	expect(barBox!.x).toBeGreaterThanOrEqual(0);
	expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(390);
	for (let button of await bar.getByRole("button").all()) {
		let box = (await button.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(28);
		expect(box.height).toBeGreaterThanOrEqual(28);
	}

	await bar.getByRole("button", { name: "Explain this" }).tap();
	await expect(target.getByRole("button", { name: "You reacted with ❓" })).toHaveText("❓1");
	await expect(bar).toBeHidden();

	await longPress(page, target);
	await bar.getByRole("button", { name: "Message actions" }).tap();
	let menu = page.getByRole("menu", { name: "Message actions" });
	await menu.getByRole("menuitem", { name: "Copy", exact: true }).tap();
	await expect.poll(() => clipboard(page)).toBe(PERSON.text);
	let box = (await menu.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);

	await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollWidth))
		.toBeLessThanOrEqual(390);
});

test("on a phone a message's text stays selectable, and a long press on it still brings up the toolbar", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
	let target = message(page, PERSON.id);
	let styles = await target.locator("[data-chat-message-text]").evaluate(element => {
		let paragraph = element.querySelector("p")!;
		return [element, paragraph].map(item => getComputedStyle(item).userSelect);
	});
	expect(styles).not.toContain("none");
	let selected = await target.locator("[data-chat-message-text] p").first().evaluate(paragraph => {
		let range = document.createRange();
		range.selectNodeContents(paragraph);
		let selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		return selection.toString();
	});
	expect(selected).toBe("Please check the rollout docs and bun test.");

	await page.evaluate(() => getSelection()!.removeAllRanges());
	await longPress(page, target);
	await expect(toolbar(target)).toBeVisible();
});

test("a long press on a link in a message brings up the toolbar and does not follow the link", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
	let target = message(page, PERSON.id);
	let popups = 0;
	page.context().on("page", () => popups++);
	let link = (await target.getByRole("link", { name: "rollout docs" }).boundingBox())!;
	let origin = (await target.boundingBox())!;
	await longPress(page, target, { x: link.x - origin.x + 6, y: link.y - origin.y + 6 });
	await expect(toolbar(target)).toBeVisible();
	await page.waitForTimeout(300);
	expect(popups).toBe(0);
});

test("the toolbar, its menu and the picker have no accessibility violations", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, PERSON.id);
	await target.hover();
	await toolbar(target).getByRole("button", { name: "Looks right" }).click();
	await target.hover();
	let scan = () =>
		new AxeBuilder({ page })
			.include("[data-chat-scroll]")
			.analyze();
	let violations = (await scan()).violations;
	expect(violations.map(item => item.id)).toEqual([]);

	let menu = await openMenu(page, target);
	let open = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
	expect(open.violations.map(item => item.id)).toEqual([]);
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");

	await target.hover();
	await toolbar(target).getByRole("button", { name: "Add reaction" }).click();
	let picker = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
	expect(picker.violations.map(item => item.id)).toEqual([]);
});

function socketRoute(page: Page) {
	let sockets: WebSocketRoute[] = [];
	let state = {
		offline: false,
		reactions: [] as Array<{ id: string; emoji: string; on: boolean }>,
	};
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		let server = socket.connectToServer();
		socket.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; id: string; emoji: string; on: boolean };
				if (frame.kind === "chat:react") {
					state.reactions.push({ id: frame.id, emoji: frame.emoji, on: frame.on });
				}
			}
			server.send(message);
		});
		server.onMessage(message => socket.send(message));
		sockets.push(socket);
	});
	return { ready, sockets, state };
}

test("a reaction asked for while the connection is down shows at once, dimmed, and goes out when it is back", async ({ join, page, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let wire = socketRoute(page);
	await wire.ready;
	let ana = await join("ana");
	let ben = await join("ben", {});
	let target = message(ana, PLANNER.id);
	await expect(message(ben, PLANNER.id)).toBeVisible();

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(ana.locator('[data-connection-banner][data-layer="socket"]')).toBeVisible();

	await target.hover();
	await toolbar(target).getByRole("button", { name: "Not quite" }).click();
	let pill = target.getByRole("button", { name: "You reacted with 👎" });
	await expect(pill).toHaveText("👎1");
	await expect(pill).toHaveAttribute("aria-pressed", "true");
	await expect(pill).toHaveAttribute("data-pending", "true");
	await expect(toolbar(target).getByRole("button", { name: "Not quite" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(wire.state.reactions).toEqual([]);
	await expect(message(ben, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(0);

	wire.state.offline = false;
	await ana.evaluate(() => dispatchEvent(new Event("online")));
	await expect(pill).not.toHaveAttribute("data-pending");
	expect(wire.state.reactions).toEqual([{ id: PLANNER.id, emoji: "👎", on: true }]);
	await expect(message(ben, PLANNER.id).getByRole("button", { name: "Ana reacted with 👎" }))
		.toHaveText("👎1");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await target.hover();
	await toolbar(target).getByRole("button", { name: "Not quite" }).click();
	await expect(target.getByRole("group", { name: "Reactions" })).toHaveCount(0);
	wire.state.offline = false;
	await ana.evaluate(() => dispatchEvent(new Event("online")));
	await expect(message(ben, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(0);
	expect(wire.state.reactions.at(-1)).toEqual({ id: PLANNER.id, emoji: "👎", on: false });
});

test("a message only this browser has can be reacted to, and the reaction is kept once the server has the message", async ({ join, page, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
	let wire = socketRoute(page);
	await wire.ready;
	let ana = await join("ana");
	let ben = await join("ben", {});
	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(ana.locator('[data-connection-banner][data-layer="socket"]')).toBeVisible();

	let draft = chatOf(ana).getByRole("combobox", {
		name: "Message",
		exact: true,
		includeHidden: true,
	});
	await draft.fill("@chopin Hold this thought");
	await draft.press("Enter");
	let mine = chatOf(ana).locator("[data-chat-message-id]").filter({ hasText: "Hold this thought" });
	await expect(mine.locator('[data-chat-delivery="sending"]')).toHaveText("Sending");

	await mine.hover();
	await expect(toolbar(mine).getByRole("button")).toHaveCount(5);
	await toolbar(mine).getByRole("button", { name: "Looks right" }).click();
	await expect(mine.getByRole("button", { name: "You reacted with ✅" })).toHaveAttribute(
		"data-pending",
		"true",
	);
	expect(wire.state.reactions).toEqual([]);

	wire.state.offline = false;
	await ana.evaluate(() => dispatchEvent(new Event("online")));
	let theirs = chatOf(ben).locator("[data-chat-message-id]").filter({
		hasText: "Hold this thought",
	});
	await expect(theirs.getByRole("button", { name: "Ana reacted with ✅" })).toHaveText("✅1");
	await expect(mine.getByRole("button", { name: "You reacted with ✅" })).not.toHaveAttribute(
		"data-pending",
	);
	expect(wire.state.reactions).toHaveLength(1);
	expect(wire.state.reactions[0]).toMatchObject({ emoji: "✅", on: true });
});

function holdingRoute(page: Page) {
	let state = { holding: true, connections: 0, heard: 0, answered: 0, held: [] as string[] };
	let live: { browser: WebSocketRoute; server: WebSocketRoute } | undefined;
	let ready = page.routeWebSocket("**/ws?**", browser => {
		state.connections++;
		let server = browser.connectToServer();
		live = { browser, server };
		browser.onMessage(message => {
			if (
				state.holding && typeof message === "string"
				&& (JSON.parse(message) as { kind: string }).kind === "chat:react"
			) {
				state.held.push(message);
			} else server.send(message);
		});
		server.onMessage(message => {
			let kind = typeof message === "string" ? (JSON.parse(message) as { kind: string }).kind : "";
			if (kind === "chat:reactions") state.heard++;
			if (kind === "chat:react") state.answered++;
			browser.send(message);
		});
	});
	return {
		ready,
		state,
		asked: () => state.held.map(message => (JSON.parse(message) as { on: boolean }).on),
		release() {
			state.holding = false;
			live!.server.send(state.held[0]!);
		},
		async cut() {
			await live!.browser.close();
			await live!.server.close();
		},
	};
}

function olderBuild(omitted: readonly string[]) {
	return async (context: BrowserContext) => {
		await context.routeWebSocket("**/ws?**", socket => {
			let server = socket.connectToServer();
			socket.onMessage(message => {
				if (typeof message !== "string") return server.send(message);
				let frame = JSON.parse(message) as Record<string, unknown>;
				if (frame.kind !== "chat:react") return server.send(message);
				for (let field of omitted) delete frame[field];
				server.send(JSON.stringify(frame));
			});
			server.onMessage(message => socket.send(message));
		});
	};
}

function reacted() {
	return transcript().map(entry =>
		entry.id === PLANNER.id ? { ...entry, reactions: [{ emoji: "✅", handles: ["ana"] }] } : entry
	);
}

async function lookRight(page: Page): Promise<void> {
	let target = message(page, PLANNER.id);
	await target.hover();
	await toolbar(target).getByRole("button", { name: "Looks right", exact: true }).click();
}

async function settled(page: Page): Promise<void> {
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
}

const SECOND_TABS: ReadonlyArray<[string, readonly string[]]> = [
	["that names its tab", []],
	["of an earlier build that numbers its asks and names no tab", ["tab"]],
];

for (const [kind, omitted] of SECOND_TABS) {
	test(`a reaction added again is kept when another tab of the same person ${kind} is heard and the connection is cut after the older removal got through`, async ({ baseURL, browser, join, page, room, seed }) => {
		test.setTimeout(120_000);
		await seed("# Actions\n", { transcript: reacted() });
		let net = holdingRoute(page);
		await net.ready;
		let first = await join("ana");
		let other = await openIsolatedRoom(browser, baseURL!, room, "ana", {}, olderBuild(omitted));
		try {
			let second = other.page;
			let mine = (tab: Page) =>
				message(tab, PLANNER.id).getByRole("button", { name: "You reacted with ✅" });
			let none = (tab: Page) => message(tab, PLANNER.id).getByRole("group", { name: "Reactions" });
			await expect(mine(first)).toHaveText("✅1");
			await expect(mine(second)).toHaveText("✅1");

			await lookRight(first);
			await expect(none(first)).toHaveCount(0);
			await lookRight(first);
			await expect.poll(() => net.asked()).toEqual([false, true]);

			await lookRight(second);
			await expect(none(second)).toHaveCount(0);
			await lookRight(second);
			await expect(mine(second)).toHaveText("✅1");
			await expect.poll(() => net.state.heard).toBeGreaterThanOrEqual(2);
			await settled(first);

			net.release();
			await expect(none(second)).toHaveCount(0);
			await net.cut();
			await first.evaluate(() => dispatchEvent(new Event("online")));

			await expect(mine(second)).toHaveText("✅1", { timeout: 20_000 });
			await expect(mine(first)).toHaveText("✅1", { timeout: 20_000 });
			expect(net.state.connections).toBeGreaterThan(1);
			let reopened = await join("ana", {});
			await expect(mine(reopened)).toHaveText("✅1");
		} finally {
			await other.close();
		}
	});
}

test("a reaction added again is kept when a client that numbers nothing is heard and the connection is cut after the older removal got through", async ({ baseURL, browser, join, page, room, seed }) => {
	test.setTimeout(120_000);
	await seed("# Actions\n", { transcript: reacted() });
	let net = holdingRoute(page);
	await net.ready;
	let ana = await join("ana");
	let mina = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"mina",
		{},
		olderBuild(["seq", "tab"]),
	);
	try {
		let anaThenMina = (tab: Page) =>
			message(tab, PLANNER.id).getByRole("button", { name: "You and Mina reacted with ✅" });
		let minaThenAna = (tab: Page) =>
			message(tab, PLANNER.id).getByRole("button", { name: "Mina and You reacted with ✅" });
		await expect(message(ana, PLANNER.id).getByRole("button", { name: "You reacted with ✅" }))
			.toHaveText("✅1");

		await lookRight(ana);
		await expect(message(ana, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(0);
		await lookRight(ana);
		await expect.poll(() => net.asked()).toEqual([false, true]);

		await lookRight(mina.page);
		await expect(anaThenMina(ana)).toHaveText("✅2");
		await settled(ana);

		net.release();
		await expect(
			message(mina.page, PLANNER.id).getByRole("button", { name: "You reacted with ✅" }),
		)
			.toHaveText("✅1");
		await net.cut();
		await ana.evaluate(() => dispatchEvent(new Event("online")));

		await expect(minaThenAna(ana)).toHaveText("✅2", { timeout: 20_000 });
		let reopened = await join("ana", {});
		await expect(minaThenAna(reopened)).toHaveText("✅2");
	} finally {
		await mina.close();
	}
});

test("an ask that changes nothing is settled by its answer alone, so the pill follows the server after it", async ({ join, page, seed }) => {
	test.setTimeout(120_000);
	await seed("# Actions\n", { transcript: transcript() });
	let net = holdingRoute(page);
	await net.ready;
	let first = await join("ana");
	let second = await join("ana", {});
	let pill = (tab: Page) =>
		message(tab, PLANNER.id).getByRole("button", { name: "You reacted with ✅" });

	await lookRight(first);
	await expect(pill(first)).toHaveAttribute("data-pending", "true");
	await expect.poll(() => net.asked()).toEqual([true]);
	await lookRight(second);
	await expect(pill(second)).toHaveText("✅1");
	await expect(pill(first)).not.toHaveAttribute("data-pending");

	net.release();
	await expect.poll(() => net.state.answered).toBeGreaterThanOrEqual(1);
	await settled(first);

	await lookRight(second);
	await expect(message(second, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(
		0,
	);
	await expect(message(first, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(0);
});

test("a clipboard that refuses a write after one it accepted takes Copied back: the item says Couldn't copy, politely", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	await page.clock.install();
	await page.evaluate(() => {
		let write = navigator.clipboard.writeText.bind(navigator.clipboard);
		(window as unknown as { refuse: boolean }).refuse = false;
		navigator.clipboard.writeText = text =>
			(window as unknown as { refuse: boolean }).refuse
				? Promise.reject(new DOMException("denied", "NotAllowedError"))
				: write(text);
	});
	let target = message(page, PERSON.id);
	let menu = await openMenu(page, target);
	await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
	await expect(menu.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
	await expect(target.getByRole("status")).toHaveText("Copied");

	await page.evaluate(() => {
		(window as unknown as { refuse: boolean }).refuse = true;
	});
	await menu.getByRole("menuitem", { name: "Copy as plain text", exact: true }).click();
	await expect(menu.getByRole("menuitem", { name: "Couldn't copy", exact: true })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Copied" })).toHaveCount(0);
	await expect(target.getByRole("status")).toHaveText("Couldn't copy");

	await page.clock.fastForward(1_600);
	await expect(menu.getByRole("menuitem", { name: "Couldn't copy" })).toHaveCount(0);
	await expect(target.getByRole("status")).toHaveText("");
	await expect(menu.getByRole("menuitem", { name: "Copy as plain text", exact: true }))
		.toBeVisible();
});

test("a clipboard that refuses the write never says Copied: the item says Couldn't copy, politely, and Copy works again afterwards", async ({ join, seed }) => {
	await seed("# Actions\n", { transcript: transcript() });
	let page = await join("ana");
	await page.context().grantPermissions([...CLIPBOARD]);
	await page.evaluate(() => {
		let write = navigator.clipboard.writeText.bind(navigator.clipboard);
		(window as unknown as { refuse: boolean }).refuse = true;
		navigator.clipboard.writeText = text =>
			(window as unknown as { refuse: boolean }).refuse
				? Promise.reject(new DOMException("denied", "NotAllowedError"))
				: write(text);
	});
	let target = message(page, PERSON.id);
	let menu = await openMenu(page, target);
	await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
	await expect(menu.getByRole("menuitem", { name: "Couldn't copy", exact: true })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Copied" })).toHaveCount(0);
	await expect(target.getByRole("status")).toHaveText("Couldn't copy");
	await expect(menu.getByRole("menuitem", { name: "Copy as plain text", exact: true }))
		.toBeVisible();

	await expect(menu.getByRole("menuitem", { name: "Couldn't copy" })).toHaveCount(0, {
		timeout: 5_000,
	});
	await expect(target.getByRole("status")).toHaveText("");

	await page.evaluate(() => {
		(window as unknown as { refuse: boolean }).refuse = false;
	});
	await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
	await expect.poll(() => clipboard(page)).toBe(PERSON.text);
	await expect(menu.getByRole("menuitem", { name: "Copied", exact: true })).toBeVisible();
});
