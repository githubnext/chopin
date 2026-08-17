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
import { expectNoHorizontalOverflow } from "./responsive";

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

test("a named fence is coloured with its source hidden by default", async ({ join, seed }) => {
	await seed("```ts\nexport function open(room: string) {\n\treturn 1;\n}\n```\n");
	let page = await join("ana");

	await expect(content(page).locator("[data-file]")).toBeVisible();

	// More than one colour is the whole claim: one would mean the grammar
	// never loaded and every token was painted as plain text.
	await expect.poll(() => colours(page)).toBeGreaterThan(1);

	// A preview replaces the source until this reader asks to edit it. The
	// document still carries the source, but it does not compete with the view.
	await expect(content(page).locator("[data-plan-source]")).toBeHidden();
	await expect(content(page).getByRole("button", { name: "Show source" })).toBeVisible();
});

test("a wide preview scrolls inside its code widget", async ({ join, seed }) => {
	await seed(
		'```ts\nexport const unbrokenPreviewLine = "ThisPreviewLineIsDeliberatelyLongEnoughToRequireTheCodeWidgetToOwnHorizontalScrollingWithoutWideningTheCollaborativeDocument";\n```\n',
	);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let preview = content(page).locator("[data-plan-preview]");
	let rendered = preview.locator(":scope > div");

	await expect(preview).toBeVisible();
	expect(await rendered.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	expect(await rendered.evaluate(node => getComputedStyle(node).overflowX)).toBe("auto");
	await expectNoHorizontalOverflow(page);
});

test("a diagram is shown with its source hidden by default", async ({ join, seed }) => {
	await seed("```mermaid\ngraph TD;\nA-->B;\n```\n");
	let page = await join("ana");

	await expect(content(page).locator("[data-plan-preview] svg")).toBeVisible();
	await expect(content(page).locator("[data-plan-source]")).toBeHidden();
	await expect(content(page).getByRole("button", { name: "Show source" })).toBeVisible();
});

test("an invalid diagram leaves its error inside the fence", async ({ join, seed }) => {
	await seed("```mermaid\nflowchart LR\nA[raw MemEntry[]]\n```\n");
	let page = await join("ana");

	await expect(content(page).locator("[data-plan-error]")).toContainText("Parse error");
	await expect(
		page.locator("body > div").filter({ hasText: "Syntax error in text" }),
	).toHaveCount(0);
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
	await content(page).getByRole("button", { name: "Show source" }).click();
	await expect(content(page).locator("[data-plan-source]")).toBeVisible();
	await content(page).getByRole("button", { name: "Hide source" }).click();

	await expect(content(page).locator("[data-plan-source]")).toBeHidden();
	await expect(content(page).locator("[data-file]")).toBeVisible();
	await expect(content(page).getByRole("button", { name: "Show source" })).toBeVisible();
});

/*
 * Two people in one fence.
 *
 * What is drawn is a projection of the shared source, so the thing worth
 * asserting is which of these facts travels: the text does, the language does,
 * and hiding the source does not. Everything drawn follows from the first two
 * and belongs to nobody.
 *
 * Playwright drives one page at a time, so these are edits that interleave
 * rather than collide — the same as everything in `collab.e2e.ts`, and enough
 * to tell a shared text apart from a copy each renderer owns. A merge of two
 * genuinely simultaneous keystrokes is `apps/web/src/collab.test.ts`, which
 * runs two providers against a real server and can hold one of them back.
 */

test("two people typing in one fence both end up in it", async ({ join, room, seed }) => {
	await seed("```ts\nlet a = 1;\nlet b = 2;\n```\n");
	let ana = await join("ana");
	let bo = await join("bo");

	/*
	 * Select everything and collapse the selection to the end you want.
	 * Clicking a line means clicking a coordinate inside a `<pre>`, and
	 * Home and End are a different key on each platform; this is neither.
	 * The fence is the whole document here, so its ends are the document's.
	 */
	await content(ana).getByRole("button", { name: "Show source" }).click();
	await content(ana).locator("[data-plan-source]").click();
	await ana.keyboard.press("ControlOrMeta+a");
	await ana.keyboard.press("ArrowLeft");
	await ana.keyboard.type("// ana ");

	await content(bo).getByRole("button", { name: "Show source" }).click();
	await content(bo).locator("[data-plan-source]").click();
	await bo.keyboard.press("ControlOrMeta+a");
	await bo.keyboard.press("ArrowRight");
	await bo.keyboard.type(" // bo");

	for (let page of [ana, bo]) {
		// The source is one shared text, so neither edit replaces the other.
		// A renderer holding a copy of the fence would have overwritten
		// whichever arrived first.
		await expect(content(page).locator("[data-plan-source]")).toContainText("// ana let a = 1;");
		await expect(content(page).locator("[data-plan-source]")).toContainText("let b = 2; // bo");

		// And what is drawn is drawn from that, on each page separately.
		await expect(content(page).locator("[data-file]")).toContainText("// ana let a = 1;");
		await expect(content(page).locator("[data-file]")).toContainText("let b = 2; // bo");
	}

	await written(ana, room, /^\/\/ ana let a = 1;\nlet b = 2; \/\/ bo$/m);
});

test("a language chosen by one is a change for everyone", async ({ join, room, seed }) => {
	await seed("```\nlet total = 1;\n```\n");
	let ana = await join("ana");
	let bo = await join("bo");

	await expect(content(bo).locator("[data-file]")).toHaveCount(0);

	await content(ana).getByRole("combobox", { name: "Code language" }).selectOption("typescript");

	// The language is a property of the fence rather than a way of looking at
	// it, so it travels: the other reader's copy is coloured too, and their
	// control says what it now is.
	await expect(content(bo).getByRole("combobox", { name: "Code language" }))
		.toHaveValue("typescript");
	await expect(content(bo).locator("[data-file]")).toBeVisible();
	await expect.poll(() => colours(bo)).toBeGreaterThan(1);

	await written(ana, room, /^```typescript$/m);
});

test("showing the source leaves everybody else's hidden", async ({ join, seed }) => {
	await seed("```ts\nlet a = 1;\n```\n");
	let ana = await join("ana");
	let bo = await join("bo");

	await expect(content(bo).locator("[data-file]")).toBeVisible();
	await content(ana).getByRole("button", { name: "Show source" }).click();
	await expect(content(ana).locator("[data-plan-source]")).toBeVisible();

	// Visibility is a way of looking at a block, not a fact about it. A reader
	// who reveals a fence for themselves has not revealed it for the other
	// person, who should keep reading the preview.
	await expect(content(bo).locator("[data-plan-source]")).toBeHidden();
	await expect(content(bo).getByRole("button", { name: "Show source" })).toBeVisible();
});
