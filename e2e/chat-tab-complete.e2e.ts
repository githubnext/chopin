/**
 * Tab completes what the composer's menus offer, as Slack's does: the highlighted person or chopin in
 * the @ menu, the highlighted part or file in the # menu and the highlighted command in the / menu,
 * exactly as Enter would, with the focus staying in the draft. In Chat's composer and a thread's.
 * Shift+Tab, and Tab with no menu open, move the focus as they always have.
 */

import { chatInput, expectChatValue } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

function chatPane(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/** github.com is not reachable from the harness; answer with a flat tile. */
async function stubAvatars(page: Page): Promise<void> {
	await page.context().route("https://github.com/*.png*", route =>
		route.fulfill({
			contentType: "image/svg+xml",
			body:
				`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg>`,
		}));
}

/** Types into the draft and waits for the menu to offer `option` highlighted. */
async function offered(page: Page, scope: Locator, typed: string, menu: string, option: RegExp) {
	let draft = chatInput(scope);
	await draft.click();
	await page.keyboard.type(typed);
	let list = scope.getByRole("listbox", { name: menu });
	await expect(list.getByRole("option", { name: option })).toHaveAttribute("aria-selected", "true");
	return list;
}

test("Tab completes the @ and # menus in Chat's composer as Enter does, and keeps the focus", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await stubAvatars(page);
	await join("cy");
	let chat = chatPane(page);
	let draft = chatInput(chat);

	// chopin, highlighted first.
	let mentions = await offered(page, chat, "Hey @ch", "Mentions", /^chopin/);
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "Hey @chopin ");
	await expect(mentions).toHaveCount(0);
	await expect(draft).toBeFocused();

	// A person, moved to with the arrows.
	await page.keyboard.type("and @");
	await expect(mentions.getByRole("option", { name: /^cy/ })).toBeVisible();
	while (
		await mentions.getByRole("option", { name: /^cy/ }).getAttribute("aria-selected") !== "true"
	) {
		await page.keyboard.press("ArrowDown");
	}
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "Hey @chopin and @cy ");
	await expect(draft).toBeFocused();

	// A file in the # menu becomes its chip.
	await draft.fill("");
	let documents = await offered(
		page,
		chat,
		"#comp",
		"Document references",
		/^src\/chat\/composer\.tsx/,
	);
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "@src/chat/composer.tsx ");
	await expect(draft.locator('.draft-reference[data-reference="file"]')).toHaveText(
		"@src/chat/composer.tsx",
	);
	await expect(documents).toHaveCount(0);
	await expect(draft).toBeFocused();
});

test("Tab chooses the highlighted command in the / menu", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let chat = chatPane(page);
	await offered(page, chat, "/res", "Commands", /^\/research/);
	await page.keyboard.press("Tab");
	// Research opens its composer in the document, as Enter does.
	await expect(
		page.getByRole("region", { name: "Research question", exact: true })
			.getByRole("textbox", { name: "Research question", exact: true }),
	).toBeFocused();
	await expectChatValue(chatInput(chat), "");
});

test("Shift+Tab and Tab with no menu open move the focus and write nothing", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await stubAvatars(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);

	await offered(page, chat, "@ch", "Mentions", /^chopin/);
	await page.keyboard.press("Shift+Tab");
	await expectChatValue(draft, "@ch");
	await expect(draft).not.toBeFocused();

	await draft.fill("no menu here");
	await draft.press("End");
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "no menu here");
	await expect(draft).not.toBeFocused();
});

test("Tab completes the @ and # menus in a thread's composer", async ({ join, seed }) => {
	await seed("# Tab completion\nThreads complete too.\n");
	let page = await join("ana", { viewport: { width: 1600, height: 900 } });
	await stubAvatars(page);
	let main = chatPane(page).locator(".chat-split-main");
	await chatInput(main).fill("Root for a thread");
	await main.getByRole("button", { name: "Send message" }).click();
	let root = main.locator(".chat-message-body", { hasText: "Root for a thread" });
	await expect(root).toBeVisible();
	await root.hover();
	await root.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	let draft = chatInput(panel);
	await expect(draft).toBeFocused();

	let mentions = await offered(page, panel, "@ch", "Mentions", /^chopin/);
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "@chopin ");
	await expect(mentions).toHaveCount(0);
	await expect(draft).toBeFocused();

	let documents = await offered(
		page,
		panel,
		"#composer",
		"Document references",
		/^src\/chat\/composer\.tsx/,
	);
	await page.keyboard.press("Tab");
	await expectChatValue(draft, "@chopin @src/chat/composer.tsx ");
	await expect(documents).toHaveCount(0);
	await expect(draft).toBeFocused();
});
