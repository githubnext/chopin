/** Starting a comment that is sent to Chopin, in a whole page or one document's surface. */
import { expect } from "./room";

import type { Locator, Page } from "@playwright/test";

/**
 * Select the paragraph holding `passage` in `scope`'s editor and post `text` on it as a
 * comment sent to Chopin. `scope` is the page, or a child document's surface when the
 * root's editor is mounted beneath it.
 */
export async function startCommentToChopin(
	page: Page,
	scope: Page | Locator,
	passage: string,
	text: string,
): Promise<void> {
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await scope.getByRole("textbox", { name: "editable markdown" })
		.locator("p", { hasText: passage })
		.first()
		.selectText();
	await scope.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let card = scope.getByRole("dialog", { name: "New comment" });
	await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
	await card.getByRole("textbox", { name: "Comment" }).fill(text);
	await card.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(card).toHaveCount(0);
}
