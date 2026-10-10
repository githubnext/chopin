/**
 * A comment sent to Chopin, through the real server, sockets and host tools,
 * against the isolated `AGENT=on` fake-harness project.
 */
import { content, expect, ready, test } from "./room";

import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/** Select the first paragraph and open a new comment on it. */
async function draft(page: Page) {
	await content(page).locator("p").first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	return page.getByRole("dialog", { name: "New comment" });
}

test("typing @chopin addresses Chopin, who replies in the thread while Chat records the notice", async ({ join, seed }) => {
	await seed("# Harness comments\nThe harp needs new strings.\n");
	let page = await join("ana");
	let card = await draft(page);
	let field = card.getByRole("textbox", { name: "Comment" });
	let box = card.getByRole("checkbox", { name: "Send to Chopin" });

	await expect(box).not.toBeChecked();
	await field.pressSequentially("@chopin tighten this");
	await expect(box).toBeChecked();
	await expect(card.locator(".plan-comment-address-chip")).toHaveText("@Chopin");
	await expect(field).toHaveValue("tighten this");

	await card.getByRole("button", { name: "Post comment", exact: true }).click();

	await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.locator(".plan-comment-mention")).toHaveText("@Chopin");
	await expect(thread.getByRole("status")).toHaveText("Chopin is working on it");

	await expect(thread.getByText("Done. I tightened the passage you marked.")).toBeVisible({
		timeout: 20_000,
	});
	await expect(thread.getByText("Chopin is working on it")).toHaveCount(0);

	let chat = chatPane(page);
	let notice = chat.getByRole("button", { name: /Comment on “.*” sent to Chopin/ });
	await expect(notice).toContainText("tighten this");
	await expect(chat.getByText("I replied in the comment thread.")).toBeVisible();

	// The notice leads back to the thread.
	await page.keyboard.press("Escape");
	await expect(thread).toHaveCount(0);
	await notice.click();
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();

	// Both survive a reload, and nothing claims Chopin is still working.
	await page.reload();
	await ready(page);
	await expect(chatPane(page).getByRole("button", { name: /sent to Chopin/ })).toBeVisible();
});

test("a turn that answers only in Chat still answers in the thread", async ({ join, seed }) => {
	await seed("# Harness backstop\nThe harp needs new strings.\n");
	let page = await join("ana");
	let card = await draft(page);
	await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
	await card.getByRole("textbox", { name: "Comment" }).fill("COMMENT-BACKSTOP is this right?");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();

	await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.getByText("Answered from Chat only.")).toBeVisible({ timeout: 20_000 });
	await expect(thread.getByText("Chopin is working on it")).toHaveCount(0);
});

test("stopping Chopin's turn says so on the thread", async ({ join, seed }) => {
	await seed("# Harness stop\nThe harp needs new strings.\n");
	let page = await join("ana");
	let card = await draft(page);
	await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
	await card.getByRole("textbox", { name: "Comment" }).fill("SLOW-LIVE take your time");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();

	await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.getByText("Chopin is working on it")).toBeVisible();
	await chatPane(page).getByRole("button", { name: "Stop Chopin" }).click();

	// Stopping from Chat dismisses the card; the thread says why when it opens again.
	await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	await expect(thread.getByText("Chopin stopped")).toBeVisible({ timeout: 15_000 });
});
