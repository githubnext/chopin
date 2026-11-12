/**
 * A thread's root and its replies have Chat's message toolbar, as Slack's thread view has it: the
 * three quick reactions, Add reaction and the menu, and no Reply in thread, since they are in that
 * thread. Their reactions are kept, live for everyone with the thread open, and the root's are Chat's
 * own. A reaction the Planner answers is answered in the thread, never in Chat. The scripted Planner
 * answers with the plan's heading and the latest pull request.
 */
import { chatInput } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const WIDE = { viewport: { width: 1600, height: 900 } };
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const ANSWER = "Latest pull request:";
const BAR = ["Looks right", "Explain this", "Not quite", "Add reaction", "Message actions"];

const ROOT = {
	id: "thread-root",
	text: "I moved the cache key into the [router notes](https://example.com/router).",
};
const OTHER = { id: "chat-other", text: "The cache is keyed by the request path." };
const REPLY = "A reply with [the rollout notes](https://example.com/rollout).";

function transcript() {
	return [
		{
			id: OTHER.id,
			author: { kind: "member", handle: "ben" },
			text: OTHER.text,
			ts: 1_700_000_001,
		},
		{ id: ROOT.id, author: { kind: "agent" }, text: ROOT.text, ts: 1_700_000_002 },
	];
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function main(page: Page): Locator {
	return chatOf(page).locator(".chat-split-main");
}

function panelOf(page: Page): Locator {
	return page.locator("[data-thread-panel]");
}

function rootIn(scope: Locator): Locator {
	return scope.locator(`[data-chat-message-id="${ROOT.id}"]`);
}

function replyIn(panel: Locator, text = "A reply with"): Locator {
	return panel.locator(".chat-message-body[data-chat-message-id]", { hasText: text });
}

function toolbar(message: Locator): Locator {
	return message.getByRole("toolbar", { name: "Reactions and actions" });
}

function pill(message: Locator, name: string): Locator {
	return message.getByRole("button", { name, exact: true });
}

async function names(bar: Locator): Promise<string[]> {
	return bar.getByRole("button").evaluateAll(buttons =>
		buttons.map(button => button.getAttribute("aria-label") ?? "")
	);
}

async function openThread(page: Page): Promise<Locator> {
	let root = rootIn(main(page));
	await root.hover();
	await toolbar(root).getByRole("button", { name: "Reply in thread" }).click();
	let panel = panelOf(page);
	await expect(panel).toBeVisible();
	await expect(rootIn(panel)).toBeVisible();
	return panel;
}

async function send(scope: Locator, text: string): Promise<void> {
	await chatInput(scope).fill(text);
	await scope.getByRole("button", { name: "Send message" }).click();
}

async function quick(message: Locator, label: string): Promise<void> {
	await message.hover();
	await toolbar(message).getByRole("button", { name: label, exact: true }).click();
}

async function pick(page: Page, message: Locator, search: string, emoji: string): Promise<void> {
	await message.hover();
	await toolbar(message).getByRole("button", { name: "Add reaction" }).click();
	let picker = page.getByRole("dialog", { name: "Add reaction" });
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill(search);
	await picker.getByRole("button", { name: emoji }).first().click();
}

/** A finger held on the message for longer than the long press, without moving. */
async function longPress(page: Page, target: Locator): Promise<void> {
	let box = (await target.boundingBox())!;
	let point = { x: box.x + 24, y: box.y + Math.min(8, box.height / 2) };
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
	// The press keeps the click its release may make from the message for half a second; a finger
	// takes longer than that to reach the bar.
	await page.waitForTimeout(600);
}

test("a thread's root and replies have Chat's toolbar without Reply in thread, and their reactions are kept, live and shared with Chat", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Thread reactions\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let cy = await join("cy", WIDE);
	let panel = await openThread(ana);
	await send(panel, REPLY);
	let root = rootIn(panel);
	let reply = replyIn(panel);
	await expect(reply).toBeVisible();

	for (let message of [root, reply]) {
		await message.hover();
		await expect(toolbar(message)).toHaveCSS("opacity", "1");
		expect(await names(toolbar(message))).toEqual(BAR);
	}
	await expect(panel.getByRole("button", { name: "Reply in thread" })).toHaveCount(0);
	await expect(panel.locator("[data-thread-trigger]")).toHaveCount(0);
	// Chat's own row keeps it.
	await rootIn(main(ana)).hover();
	await expect(toolbar(rootIn(main(ana))).getByRole("button", { name: "Reply in thread" }))
		.toHaveCount(1);

	let cyPanel = await openThread(cy);
	await expect(replyIn(cyPanel)).toBeVisible();

	await pick(ana, reply, "tada", "🎉");
	await expect(pill(reply, "You reacted with 🎉")).toHaveText("🎉1");
	await expect(pill(replyIn(cyPanel), "ana reacted with 🎉")).toHaveText("🎉1");
	// A reply's reaction is the thread's: Chat has no such message.
	await expect(main(ana).getByRole("button", { name: /reacted with 🎉/ })).toHaveCount(0);

	await quick(root, "Looks right");
	await expect(pill(root, "You reacted with ✅")).toHaveText("✅1");
	await expect(pill(rootIn(main(ana)), "You reacted with ✅")).toHaveText("✅1");
	await expect(pill(rootIn(main(cy)), "ana reacted with ✅")).toHaveText("✅1");
	await expect(pill(rootIn(cyPanel), "ana reacted with ✅")).toHaveText("✅1");

	await pill(rootIn(cyPanel), "ana reacted with ✅").click();
	await expect(pill(rootIn(cyPanel), "ana and You reacted with ✅")).toHaveText("✅2");
	await expect(pill(root, "You and cy reacted with ✅")).toHaveText("✅2");
	await expect(pill(rootIn(main(ana)), "You and cy reacted with ✅")).toHaveText("✅2");

	// A reply also sent to Chat is one message in both: its reactions are too.
	await panel.getByLabel("Also send to Chat").check();
	await send(panel, "Shared conclusion: the router owns the key.");
	let shared = replyIn(panel, "Shared conclusion");
	let sharedInChat = main(cy).locator(".chat-message-body[data-chat-message-id]", {
		hasText: "Shared conclusion",
	});
	await expect(sharedInChat).toBeVisible();
	await quick(shared, "Not quite");
	await expect(pill(shared, "You reacted with 👎")).toHaveText("👎1");
	await expect(pill(sharedInChat, "ana reacted with 👎")).toHaveText("👎1");
	await quick(sharedInChat, "Not quite");
	await expect(pill(shared, "You and cy reacted with 👎")).toHaveText("👎2");

	await ana.reload();
	await expect(pill(rootIn(main(ana)), "You and cy reacted with ✅")).toHaveText("✅2");
	panel = await openThread(ana);
	reply = replyIn(panel);
	await expect(pill(reply, "You reacted with 🎉")).toHaveText("🎉1");
	await expect(pill(rootIn(panel), "You and cy reacted with ✅")).toHaveText("✅2");

	await pill(reply, "You reacted with 🎉").click();
	await expect(reply.getByRole("group", { name: "Reactions" })).toHaveCount(0);
	await expect(replyIn(cyPanel).getByRole("group", { name: "Reactions" })).toHaveCount(0);
	await ana.reload();
	panel = await openThread(ana);
	await expect(replyIn(panel)).toBeVisible();
	await expect(replyIn(panel).getByRole("group", { name: "Reactions" })).toHaveCount(0);
});

test("❓ and 👎 in a thread are answered in that thread and never in Chat, and ✅ starts no turn", async ({ join, seed }) => {
	test.setTimeout(180_000);
	await seed("# Thread reactions\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let panel = await openThread(ana);
	let answers = panel.locator(".chat-message-body[data-chat-message-id]", { hasText: ANSWER });

	await quick(rootIn(panel), "Explain this");
	await expect(pill(rootIn(panel), "You reacted with ❓")).toHaveText("❓1");
	await expect(answers).toHaveCount(1, { timeout: 60_000 });
	await expect(main(ana)).not.toContainText(ANSWER);

	// An answer to a reaction is not answered again, as in Chat; an answer to a reply is.
	await send(panel, "@chopin which cache key did you pick?");
	await expect(answers).toHaveCount(2, { timeout: 60_000 });
	let answer = answers.nth(1);
	await quick(answer, "Not quite");
	await expect(pill(answer, "You reacted with 👎")).toHaveText("👎1");
	await expect(answers).toHaveCount(3, { timeout: 60_000 });
	await expect(main(ana)).not.toContainText(ANSWER);

	await quick(answer, "Looks right");
	await expect(pill(answer, "You reacted with ✅")).toHaveText("✅1");
	await ana.waitForTimeout(10_000);
	await expect(answers).toHaveCount(3);
	await expect(main(ana)).not.toContainText(ANSWER);
	// The thread's replies are counted in Chat, which shows none of them.
	await expect(rootIn(main(ana)).locator("[data-thread-summary]")).toContainText(/\d+ replies/);
});

test("on a phone a long press in a thread brings up the toolbar without Reply in thread, and Add reaction opens the sheet", async ({ join, seed }) => {
	await seed("# Thread reactions\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
	let chatRoot = rootIn(chatOf(page));
	await longPress(page, chatRoot);
	await toolbar(chatRoot).getByRole("button", { name: "Reply in thread" }).tap();
	let panel = panelOf(page);
	await expect(panel).toHaveAttribute("data-thread-sheet", "true");
	await send(panel, REPLY);
	let reply = replyIn(panel);
	await expect(reply).toBeVisible();

	let bar = toolbar(reply);
	await expect(bar).toBeHidden();
	await longPress(page, reply);
	await expect(bar).toBeVisible();
	expect(await names(bar)).toEqual(BAR);
	await bar.getByRole("button", { name: "Add reaction" }).tap();
	let sheet = page.locator(".chat-message-picker[data-sheet]");
	await expect(sheet).toBeVisible();
	await expect.poll(async () => (await sheet.boundingBox())?.width).toBe(390);
	await sheet.getByRole("textbox", { name: "Search emoji, or paste one" }).fill("eyes");
	await sheet.getByRole("button", { name: "👀" }).first().tap();
	await expect(pill(reply, "You reacted with 👀")).toHaveText("👀1");

	let root = rootIn(panel);
	await longPress(page, root);
	await expect(toolbar(root)).toBeVisible();
	expect(await names(toolbar(root))).toEqual(BAR);
	await toolbar(root).getByRole("button", { name: "Looks right" }).tap();
	await expect(pill(root, "You reacted with ✅")).toHaveText("✅1");
	await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollWidth))
		.toBeLessThanOrEqual(390);
});

test("in a thread the toolbar is a keyboard path after each message's own links, and reacts with Enter", async ({ join, seed }) => {
	await seed("# Thread reactions\n", { transcript: transcript() });
	let page = await join("ana", WIDE);
	let panel = await openThread(page);
	await send(panel, REPLY);
	let root = rootIn(panel);
	let reply = replyIn(panel);
	await expect(reply).toBeVisible();
	let rootButtons = toolbar(root).getByRole("button");
	let replyButtons = toolbar(reply).getByRole("button");

	await root.getByRole("link", { name: "router notes" }).focus();
	await page.keyboard.press("Tab");
	await expect(rootButtons.nth(0)).toBeFocused();
	await expect(toolbar(root)).toHaveCSS("opacity", "1");
	await page.keyboard.press("ArrowRight");
	await expect(rootButtons.nth(1)).toBeFocused();
	await page.keyboard.press("End");
	await expect(rootButtons.nth(4)).toBeFocused();
	await expect(rootButtons.nth(4)).toHaveAttribute("aria-label", "Message actions");
	await page.keyboard.press("Home");
	await expect(rootButtons.nth(0)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(pill(root, "You reacted with ✅")).toHaveText("✅1");

	await page.keyboard.press("Tab");
	await expect(reply.getByRole("link", { name: "the rollout notes" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(replyButtons.nth(0)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(replyButtons.nth(4)).toBeFocused();
	await page.keyboard.press("Enter");
	let menu = page.getByRole("menu", { name: "Message actions" });
	await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeFocused();
	await expect(menu.getByRole("menuitem")).toHaveText(["Copy", "Copy as plain text"]);
	await page.keyboard.press("Escape");
	await expect(replyButtons.nth(4)).toBeFocused();
	await expect(panel).toBeVisible();
});
