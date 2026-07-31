/**
 * Fences, drawn.
 *
 * Colour is the point of all of this and there is no colour without a browser:
 * the highlighter is loaded on demand, tokenises in the page, and paints into a
 * shadow root that only a real DOM has. What can be decided without one — what
 * a fence's language and title mean, and what to do about a patch nobody wrote
 * correctly — is `code.test.ts`, and none of it is repeated here.
 *
 * Playwright's selectors cross an open shadow root, so the renderer's own
 * attributes are the address for what it drew: `data-file` is a file, and
 * `data-diff` is a change. Which of the two turned up is most of what these
 * tests are about.
 */

import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

let MENU = { name: "Insert block" };

/** A fence with the counts a person or a model actually writes. */
const PATCH = `\`\`\`diff
--- a/apps/server/src/plan/room.ts
+++ b/apps/server/src/plan/room.ts
@@ -1,9 +1,9 @@
 export function open(room: string): Plan {
-	return { doc, epoch: 1 };
+	let epoch = rotate(room);
+	return { doc, epoch };
 }
\`\`\`
`;

/** How many colours the highlighter ended up using. */
async function colours(page: Page): Promise<number> {
	return await page
		.locator("[data-line] span[style*='color']")
		.evaluateAll(nodes => new Set(nodes.map(node => (node as HTMLElement).style.color)).size);
}

test("a named fence is coloured, beside the source it came from", async ({ join, seed }) => {
	await seed("```ts\nexport function open(room: string) {\n\treturn 1;\n}\n```\n");
	let page = await join("ana");

	await expect(content(page).locator("[data-file]")).toBeVisible();

	// More than one colour is the whole claim: one would mean the grammar
	// never loaded and every token was painted as plain text.
	await expect.poll(() => colours(page)).toBeGreaterThan(1);

	// The source is what the room is collaborating in, and it stays. A preview
	// that replaced it would be a second copy of the text with the caret in
	// the wrong one.
	await expect(content(page).locator("[data-plan-source]")).toContainText("export function open");
});

test("naming a fence colours it, and the name reaches the file", async ({ join, room, seed }) => {
	await seed("```\nlet total = 1;\n```\n");
	let page = await join("ana");

	// Nothing is drawn for a fence with no language: an uncoloured copy beside
	// an uncoloured original is two of the same thing.
	await expect(content(page).locator("[data-file]")).toHaveCount(0);

	await content(page).getByRole("combobox", { name: "Code language" }).selectOption("typescript");

	await expect(content(page).locator("[data-file]")).toBeVisible();
	await expect.poll(() => colours(page)).toBeGreaterThan(1);

	// The language is a property of the fence, so choosing one is an edit —
	// and an edit that does not reach the file is a colour nobody else sees.
	await written(page, room, /^```typescript$/m);
});

test("a patch is drawn as the change it describes", async ({ join, seed }) => {
	await seed(PATCH);
	let page = await join("ana");

	let diff = content(page).locator("[data-diff]");
	await expect(diff).toBeVisible();

	// Named, because the filename is what a patch has that a snippet does not,
	// and it survives the `a/` and `b/` git puts in front of it.
	await expect(content(page).locator("[data-title]")).toHaveText("apps/server/src/plan/room.ts");

	await expect(diff.locator("[data-line-type='change-addition']").first()).toBeVisible();
	await expect(diff.locator("[data-line-type='change-deletion']").first()).toBeVisible();

	// All of it, because the header claimed nine lines where there are four. A
	// renderer that believed the header stops reading when it runs out, and
	// draws half a change — which is a change nobody proposed.
	await expect(diff).toContainText("let epoch = rotate(room);");
	await expect(diff).toContainText("return { doc, epoch };");
	await expect(diff).toContainText("return { doc, epoch: 1 };");
});

test("a fence that is not a patch is drawn as the text it is", async ({ join, seed }) => {
	await seed("```diff\n- let a = 1;\n+ let a = 2;\n```\n");
	let page = await join("ana");

	// Coloured as a diff, which it looks like, and not presented as a change
	// to a file: there is no file, no line numbers and no hunk here, and
	// inventing them would put all three in the reader's head.
	await expect(content(page).locator("[data-file]")).toBeVisible();
	await expect(content(page).locator("[data-diff]")).toHaveCount(0);
});

test("enter is a newline in a fence, and twice over is the way out", async ({ join, room }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/code");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Code block" }).click();

	await page.keyboard.type("let a = 1;");
	await page.keyboard.press("Enter");
	await page.keyboard.type("let b = 2;");

	// Lexical asks a block to make its own successor and a code block cannot,
	// so without this Enter does nothing at all — and a fence at the end of a
	// plan is a corner somebody can be typed into.
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("And then ship it.");

	await written(page, room, /```\nlet a = 1;\nlet b = 2;\n```\n\nAnd then ship it\./);
});

test("hiding the source leaves what was drawn from it", async ({ join, seed }) => {
	await seed("```ts\nexport function open(room: string) {\n\treturn 1;\n}\n```\n");
	let page = await join("ana");

	await expect(content(page).locator("[data-file]")).toBeVisible();
	await content(page).getByRole("button", { name: "Hide source" }).click();

	await expect(content(page).locator("[data-plan-source]")).toBeHidden();
	await expect(content(page).locator("[data-file]")).toBeVisible();
	await expect(content(page).getByRole("button", { name: "Show source" })).toBeVisible();
});
