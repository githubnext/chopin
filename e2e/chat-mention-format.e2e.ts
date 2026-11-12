/**
 * Every valid @mention is drawn as a mention, in the draft as it is typed and in the sent message:
 * every one of them, not only the first, wherever it sits (several in a paragraph or a list item,
 * side by side, against punctuation, at the start or end of a line, in bold or italic, in a thread).
 * A login no one here has stays words.
 */

import { chatInput } from "./chat-input";
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

/**
 * Types a message line by line, as a person does. In Chat's composer Escape then closes a menu a
 * mention at the end opened; in a thread it would close the thread, so its lines end in words.
 */
async function type(page: Page, draft: Locator, lines: string[], close = true): Promise<void> {
	await draft.click();
	for (let [index, line] of lines.entries()) {
		if (index) await page.keyboard.press("Shift+Enter");
		await page.keyboard.type(line);
	}
	if (close) await page.keyboard.press("Escape");
}

/** The logins drawn as mentions in a scope, in order. */
function mentioned(scope: Locator, selector: string): Promise<string[]> {
	return scope.locator(selector).evaluateAll(elements =>
		elements.map(element => element.textContent ?? "")
	);
}

/** The text of the sent message holding `words`. */
function sentMessage(scope: Locator, words: string): Locator {
	return scope.locator("[data-chat-message-text]").filter({ hasText: words }).last();
}

test("every valid mention is drawn as one, in the draft and in the sent message", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await stubAvatars(page);
	await join("cy");
	await join("bo");
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });

	let cases: { lines: string[]; find: string; mentions: string[] }[] = [
		{ lines: ["@cy @bo can you look"], find: "can you look", mentions: ["@cy", "@bo"] },
		{
			lines: ["Thanks @cy, @bo and @ana."],
			find: "Thanks",
			mentions: ["@cy", "@bo", "@ana"],
		},
		{
			lines: ["@bo starts the line and it ends with @cy"],
			find: "starts the line",
			mentions: ["@bo", "@cy"],
		},
		{
			lines: ["- first for @cy and @bo", "second for @ana"],
			find: "first for",
			mentions: ["@cy", "@bo", "@ana"],
		},
		{ lines: ["@zed is not here but @cy is"], find: "is not here", mentions: ["@cy"] },
	];
	for (let { lines, find, mentions } of cases) {
		await type(page, draft, lines);
		await expect.poll(() => mentioned(draft, ".draft-mention")).toEqual(mentions);
		await send.click();
		await expect(sentMessage(chat, find)).toBeVisible();
		await expect.poll(() => mentioned(sentMessage(chat, find), ".chat-mention")).toEqual(mentions);
	}

	// In bold and in italic.
	await draft.click();
	await page.keyboard.press("ControlOrMeta+b");
	await page.keyboard.type("@cy");
	await page.keyboard.press("ControlOrMeta+b");
	await page.keyboard.type(" and ");
	await page.keyboard.press("ControlOrMeta+i");
	await page.keyboard.type("@bo");
	await page.keyboard.press("ControlOrMeta+i");
	await page.keyboard.type(" in emphasis");
	await page.keyboard.press("Escape");
	await expect.poll(() => mentioned(draft, ".draft-mention")).toEqual(["@cy", "@bo"]);
	await send.click();
	let emphasis = sentMessage(chat, "in emphasis");
	await expect.poll(() => mentioned(emphasis, "strong .chat-mention")).toEqual(["@cy"]);
	await expect.poll(() => mentioned(emphasis, "em .chat-mention")).toEqual(["@bo"]);
});

test("a thread reply draws every mention too", async ({ join, seed }) => {
	await seed("# Mentions in threads\nEvery name counts.\n");
	let page = await join("ana", { viewport: { width: 1600, height: 900 } });
	await stubAvatars(page);
	await join("cy");
	await join("bo");
	let main = chatPane(page).locator(".chat-split-main");
	await chatInput(main).fill("Root for mentions");
	await main.getByRole("button", { name: "Send message" }).click();
	let root = main.locator(".chat-message-body", { hasText: "Root for mentions" });
	await expect(root).toBeVisible();
	await root.hover();
	await root.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	let draft = chatInput(panel);
	await expect(draft).toBeFocused();

	await type(page, draft, ["@cy @bo and @ana, in a thread"], false);
	await expect.poll(() => mentioned(draft, ".draft-mention")).toEqual(["@cy", "@bo", "@ana"]);
	await panel.getByRole("button", { name: "Send message" }).click();
	let reply = sentMessage(panel, "in a thread");
	await expect(reply).toBeVisible();
	await expect.poll(() => mentioned(reply, ".chat-mention")).toEqual(["@cy", "@bo", "@ana"]);
});
