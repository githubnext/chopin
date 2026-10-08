import { chatInput, expectChatValue } from "./chat-input";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function researchQuestion(page: Page) {
	return page.getByRole("region", { name: "Research question", exact: true })
		.getByRole("textbox", { name: "Research question", exact: true });
}

test("/research in Chat opens the document's research composer instead of posting", async ({ join, page: first, seed }) => {
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
	let question = researchQuestion(page);

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

	// No command menu for a path.
	await draft.fill("/usr/bin");
	await expect(menu).toHaveCount(0);

	// Choosing Research opens an empty composer after the last paragraph.
	await draft.fill("");
	await page.keyboard.type("/res");
	await page.keyboard.press("Enter");
	await expect(question).toBeFocused();
	await expect(question).toHaveValue("");
	await expectChatValue(draft, "");
	await page.keyboard.press("Escape");
	await expect(question).toHaveCount(0);
	await expect(content(page).getByText("Some prose.", { exact: true })).toBeVisible();

	// Sending a typed brief opens the composer with it, reusing the empty last paragraph.
	await draft.fill("/research what changed upstream?");
	await expect(menu).toHaveCount(0);
	await draft.press("Enter");
	await expect(question).toBeFocused();
	await expect(question).toHaveValue("what changed upstream?");
	await expectChatValue(draft, "");
	await expect(content(page).locator(":scope > p")).toHaveCount(2);
	// The caret follows the prefilled brief.
	await page.keyboard.type("!");
	await expect(question).toHaveValue("what changed upstream?!");

	// With a draft already open, Chat keeps its draft and points to that draft.
	let notice = chat.getByRole("status").filter({
		hasText: "already being written in the document",
	});
	await draft.fill("@chopin /research another question");
	await draft.press("Enter");
	await expect(notice).toBeVisible();
	await expectChatValue(draft, "@chopin /research another question");
	await chat.getByRole("button", { name: "Go to it", exact: true }).click();
	await expect(question).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(question).toHaveCount(0);

	// A brief longer than the composer accepts is refused in Chat.
	await draft.fill(`/research ${"a".repeat(4097)}`);
	await draft.press("Enter");
	await expect(chat.getByRole("status").filter({ hasText: "Briefs can be up to 4,096 characters" }))
		.toBeVisible();
	await expect(question).toHaveCount(0);
	await draft.fill("");

	expect(sent).toEqual([]);
	await expect(chat.locator("[data-chat-stack]").getByText("/research", { exact: false }))
		.toHaveCount(0);
});
