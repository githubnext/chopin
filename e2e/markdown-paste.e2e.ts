/**
 * Plain-text Markdown, pasted.
 *
 * `markdown-paste.test.ts` covers what counts as Markdown and what it becomes.
 * Only a browser can show that a real paste event reaches that path ahead of
 * Lexical's literal one, that ⇧⌘V still opts out, and that the result syncs.
 */

import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const MARKDOWN = [
	"## Pasted heading",
	"",
	"- first **bold** item",
	"- second [link](https://example.com)",
	"",
	"```ts",
	"let a = 1;",
	"```",
].join("\n");

async function paste(page: Page, text: string, options: { plain?: boolean } = {}) {
	if (options.plain) {
		await content(page).dispatchEvent("keydown", { key: "V", shiftKey: true, metaKey: true });
	}
	await content(page).evaluate((root, text) => {
		let data = new DataTransfer();
		data.setData("text/plain", text);
		root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	}, text);
}

test("pasted Markdown arrives as the blocks it describes", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await paste(page, MARKDOWN);

	await expect(content(page).getByRole("heading", { level: 2 })).toHaveText("Pasted heading");
	await expect(content(page).getByRole("listitem")).toHaveCount(2);
	await expect(content(page).locator("strong, b").getByText("bold")).toBeVisible();
	await expect(content(page).getByRole("link", { name: "link" })).toHaveAttribute(
		"href",
		"https://example.com",
	);
	await expect(content(page)).not.toContainText("##");
	await written(page, room, /^## Pasted heading$/m);
	await written(page, room, /^- first \*\*bold\*\* item$/m);
	await written(page, room, /^```ts\nlet a = 1;\n```$/m);
});

test("ordinary prose, components and ⇧⌘V paste literally", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await paste(page, "#1 priority is 5 * 3");
	await expect(content(page)).toContainText("#1 priority is 5 * 3");

	await page.keyboard.press("Enter");
	await paste(page, "## Not a heading", { plain: true });
	await expect(content(page)).toContainText("## Not a heading");

	await page.keyboard.press("Enter");
	await paste(page, '**Card** <Questionnaire id="x" />');
	await expect(content(page).getByRole("heading")).toHaveCount(0);
	await expect(content(page)).toContainText('Card <Questionnaire id="x" />');
	await written(page, room, /Not a heading/);
	await written(page, room, /Questionnaire id="x"/);
});
