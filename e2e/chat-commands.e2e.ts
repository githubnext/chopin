import { chatInput, expectChatValue } from "./chat-input";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

test("/ in Chat offers Research, which points to the document instead of posting", async ({ join, page: first, seed }) => {
	await seed("# Slash commands\n\nSome prose.\n");
	let sent: string[] = [];
	first.on("websocket", socket => {
		socket.on("framesent", frame => {
			if (typeof frame.payload === "string" && frame.payload.includes('"chat:send"')) {
				sent.push(frame.payload);
			}
		});
	});
	let page = await join("ana");
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let menu = chat.getByRole("listbox", { name: "Commands" });
	let hint = chat.getByRole("status").filter({ hasText: "Use /research in the document" });

	await draft.click();
	await page.keyboard.type("/");
	await expect(menu).toBeVisible();
	await expect(draft).toHaveAttribute("aria-expanded", "true");
	await expect(menu.getByRole("option", { name: "Research", exact: true }))
		.toHaveAttribute("aria-selected", "true");

	// Escape closes only the menu; the draft and focus stay.
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(draft).toBeFocused();
	await expectChatValue(draft, "/");

	await page.keyboard.type("res");
	await expect(menu).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(menu).toHaveCount(0);
	await expectChatValue(draft, "/research ");
	await expect(hint).toBeVisible();
	await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled();

	// A typed brief is never posted as a literal message either.
	await page.keyboard.type("what changed?");
	await page.keyboard.press("Enter");
	await expect(hint).toBeVisible();
	await expectChatValue(draft, "/research what changed?");

	// No command menu for a path or a later slash.
	await draft.fill("/usr/bin");
	await expect(menu).toHaveCount(0);
	await expect(hint).toHaveCount(0);

	await draft.fill("/research");
	await chat.getByRole("button", { name: "Go to document" }).click();
	await expectChatValue(draft, "");
	let editor = content(page);
	await expect(editor).toBeFocused();
	await page.keyboard.type("!");
	await expect(editor.getByText("Some prose.!", { exact: true })).toBeVisible();
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("region", { name: "Research question", exact: true })
			.getByRole("textbox", { name: "Research question", exact: true }),
	).toBeFocused();

	expect(sent).toEqual([]);
	await expect(chat.getByText("/research", { exact: true })).toHaveCount(0);
});
