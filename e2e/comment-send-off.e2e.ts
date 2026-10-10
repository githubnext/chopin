/** A comment sent to Chopin on a server that runs without one is kept, and says so. */
import { content, expect, test } from "./room";

test("a comment sent to Chopin with no Planner running is saved and says Chopin isn't running", async ({ join, seed }) => {
	await seed("# No Planner\nThe harp needs new strings.\n");
	let page = await join("ana");
	await content(page).locator("p").first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let card = page.getByRole("dialog", { name: "New comment" });
	await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
	await card.getByRole("textbox", { name: "Comment" }).fill("Can you shorten this?");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();

	await page.getByRole("button", { name: /^Comment on “.*”\. / }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.getByText("Can you shorten this?")).toBeVisible();
	await expect(thread.locator(".plan-comment-mention")).toHaveText("@Chopin");
	await expect(thread.getByText("Chopin isn't running")).toBeVisible();

	// Backspace at the start of a reply drops the address it was given.
	let reply = thread.getByRole("textbox", { name: "Reply" });
	await reply.click();
	let box = thread.getByRole("checkbox", { name: "Send to Chopin" });
	await expect(box).toBeVisible();
	await reply.pressSequentially("@CHOPIN ");
	await expect(box).toBeChecked();
	await reply.press("Backspace");
	await expect(box).not.toBeChecked();

	// A mention that ends the text still addresses Chopin when Enter sends it.
	await reply.fill("");
	await reply.pressSequentially("shorter please @chopin");
	await expect(box).not.toBeChecked();
	await reply.press("Enter");
	await expect(thread.locator(".plan-comment-mention")).toHaveCount(2);
	await expect(thread.getByText("shorter please", { exact: true })).toHaveCount(0);
	await expect(thread.locator(".plan-comment-note-body").last()).toHaveText(
		"@Chopin shorter please",
	);
});
