/**
 * Notion's block editing: Escape selects the block, the keys act on blocks selected as blocks, a
 * handle drags them and opens their menu, and Backspace at the start of a heading or a list item
 * makes it text before it merges.
 */

import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

function selected(page: Page) {
	return content(page).locator("[data-block-selected]");
}

/**
 * Wait until the editor has read the page's caret. Lexical takes a caret the browser moved (a
 * click, Home, End) from the `selectionchange` that follows, a task later; on a slow runner the
 * next key can arrive first and act where the caret was before.
 */
async function settle(page: Page): Promise<void> {
	await expect.poll(() =>
		page.evaluate(() => {
			type Point = { key: string; offset: number; type: string };
			let root = document.querySelector<HTMLElement>(".plan-content");
			let editor = (root as unknown as {
				__lexicalEditor?: {
					getEditorState(): { _selection: { anchor?: Point; focus?: Point } | null };
					getElementByKey(key: string): HTMLElement | null;
				};
			} | null)?.__lexicalEditor;
			let dom = getSelection();
			let selection = editor?.getEditorState()._selection;
			if (!editor || !dom?.anchorNode || !dom.focusNode) return false;
			// Blocks selected as blocks have no caret to agree on.
			if (!selection?.anchor || !selection.focus) return true;
			let agrees = (point: Point, node: Node, offset: number) => {
				let element = editor.getElementByKey(point.key);
				if (!element?.contains(node)) return false;
				return point.type !== "text" || point.offset === offset;
			};
			return agrees(selection.anchor, dom.anchorNode, dom.anchorOffset)
				&& agrees(selection.focus, dom.focusNode, dom.focusOffset);
		})
	).toBe(true);
}

/** Press a key that moves the browser's caret, and wait for the editor to read where it went. */
async function move(page: Page, key: string): Promise<void> {
	await page.keyboard.press(key);
	await settle(page);
}

test("Escape selects the block, arrows move and extend the selection, Delete removes it", async ({ join, room, seed }) => {
	await seed("One.\n\nTwo.\n\nThree.\n\nFour.\n");
	let page = await join("ana");
	await content(page).getByText("Two.").click();
	await settle(page);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(1);
	await expect(selected(page)).toHaveText("Two.");
	// The editor keeps the keyboard: the page did not take focus back.
	await expect(content(page)).toBeFocused();

	await page.keyboard.press("ArrowDown");
	await expect(selected(page)).toHaveText("Three.");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowUp");
	await expect(selected(page)).toHaveText("One.");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await expect(selected(page)).toHaveText(["One.", "Two.", "Three."]);
	await page.keyboard.press("Shift+ArrowUp");
	await expect(selected(page)).toHaveText(["One.", "Two."]);

	// Typing does nothing to blocks selected as blocks.
	await page.keyboard.type("x");
	await page.keyboard.press("Backspace");
	await expect(selected(page)).toHaveCount(0);
	await written(page, room, /^Three\.\n\nFour\.$/m);
});

test("a second Escape lets go, Enter edits at the block's end, and a click leaves block selection", async ({ join, room, seed }) => {
	await seed("One.\n\nTwo.\n");
	let page = await join("ana");
	await content(page).getByText("One.").click();
	await settle(page);
	await move(page, "Home");
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveText("One.");
	await page.keyboard.press("Enter");
	await expect(selected(page)).toHaveCount(0);
	await page.keyboard.type(" End.");
	await written(page, room, /^One\. End\.$/m);

	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);

	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await content(page).getByText("Two.").click();
	await settle(page);
	await expect(selected(page)).toHaveCount(0);
	await move(page, "End");
	await page.keyboard.type(" Clicked.");
	await written(page, room, /^Two\. Clicked\.$/m);
});

test("selected blocks copy as Markdown and paste back as the same blocks; cut removes them", async ({ join, room, seed }) => {
	await seed("## Plan\n\n- First\n- Second\n\nAfter.\n");
	let page = await join("ana");
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await content(page).getByText("Plan").click();
	await settle(page);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await expect(selected(page)).toHaveCount(3);
	await page.keyboard.press("ControlOrMeta+c");
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("## Plan\n\n- First\n- Second");

	await content(page).getByText("After.").click();
	await settle(page);
	await move(page, "End");
	await page.keyboard.press("Enter");
	await settle(page);
	await page.keyboard.press("ControlOrMeta+v");
	await written(page, room, /After\.\n\n## Plan\n\n- First\n- Second\s*$/);

	// Cut the pasted copy away again.
	await content(page).getByText("After.").click();
	await settle(page);
	await page.keyboard.press("Escape");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("ControlOrMeta+x");
	await written(page, room, /^## Plan\n\n- First\n- Second\n\nAfter\.\s*$/m);
});

test("Mod+D duplicates the selected blocks and Mod+Shift+arrows move them", async ({ join, room, seed }) => {
	await seed("One.\n\nTwo.\n\nThree.\n");
	let page = await join("ana");
	await content(page).getByText("One.").click();
	await settle(page);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
	await written(page, room, /^Three\.\n\nOne\.\n\nTwo\.\s*$/m);
	await expect(selected(page)).toHaveText(["One.", "Two."]);
	await page.keyboard.press("ControlOrMeta+d");
	await written(page, room, /^Three\.\n\nOne\.\n\nTwo\.\n\nOne\.\n\nTwo\.\s*$/m);
	// The copies are what is selected now.
	await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await written(page, room, /^One\.\n\nTwo\.\n\nThree\.\n\nOne\.\n\nTwo\.\s*$/m);
});

test("the second Escape in a code block selects the block it left", async ({ join, room, seed }) => {
	await seed("```ts\nlet a = 1;\n```\n\nAfter.\n");
	let page = await join("ana");
	await content(page).getByText("let a = 1;").click();
	await settle(page);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(1);
	await expect(selected(page)).toContainText("let a = 1;");
	await page.keyboard.press("Delete");
	await written(page, room, /^(?![\s\S]*let a)[\s\S]*After\.\s*$/);
});

test("a drag across two blocks' text selects them as blocks", async ({ join, seed }) => {
	await seed("First paragraph here.\n\nSecond paragraph here.\n\nThird.\n");
	let page = await join("ana");
	let first = await content(page).getByText("First paragraph here.").boundingBox();
	let second = await content(page).getByText("Second paragraph here.").boundingBox();
	await page.mouse.move(first!.x + 30, first!.y + first!.height / 2);
	await page.mouse.down();
	await page.mouse.move(first!.x + 60, first!.y + first!.height / 2, { steps: 4 });
	// Within one block the drag selects text, as it always has.
	await expect(selected(page)).toHaveCount(0);
	await page.mouse.move(second!.x + 40, second!.y + second!.height / 2, { steps: 8 });
	await page.mouse.up();
	await expect(selected(page)).toHaveText(["First paragraph here.", "Second paragraph here."]);
	await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
});

test("the handle drags a block to where the line shows, and its menu turns, duplicates and deletes", async ({ join, room, seed }) => {
	await seed("One.\n\nTwo.\n\nThree.\n");
	let page = await join("ana");
	let handle = page.getByRole("button", { name: "Block options" });
	await content(page).getByText("Three.").hover();
	await expect(handle).toBeVisible();

	let grip = await handle.boundingBox();
	let one = await content(page).getByText("One.").boundingBox();
	await page.mouse.move(grip!.x + 10, grip!.y + 10);
	await page.mouse.down();
	await page.mouse.move(grip!.x + 10, one!.y + 2, { steps: 10 });
	await expect(page.locator("[data-block-drop]")).toBeVisible();
	await page.mouse.up();
	await expect(page.locator("[data-block-drop]")).toHaveCount(0);
	await written(page, room, /^Three\.\n\nOne\.\n\nTwo\.\s*$/m);

	await content(page).getByText("Two.").hover();
	await handle.click();
	let menu = page.getByRole("menu", { name: "Block" });
	await expect(menu).toBeVisible();
	await expect(menu).toHaveCSS("opacity", "1");
	await expect(selected(page)).toHaveText("Two.");
	await menu.getByRole("menuitem", { name: "Heading 2" }).click();
	await written(page, room, /^## Two\.$/m);

	await content(page).getByText("One.").hover();
	await handle.click();
	await menu.getByRole("menuitem", { name: "Duplicate" }).click();
	await written(page, room, /^One\.\n\nOne\.$/m);

	// The keyboard's way to the same menu.
	await content(page).getByText("Three.").click();
	await settle(page);
	await page.keyboard.press("ControlOrMeta+/");
	await expect(menu).toBeVisible();
	await expect(selected(page)).toHaveText("Three.");
	// The menu's own End: its last item.
	await page.keyboard.press("End");
	await expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
		"data-active",
		"true",
	);
	await page.keyboard.press("Enter");
	await written(page, room, /^(?![\s\S]*Three\.)[\s\S]*One\.\n\nOne\.\n\n## Two\.\s*$/);
});

test("Backspace at the start of a heading or a list item makes it text, then merges", async ({ join, room, seed }) => {
	await seed("Intro.\n\n## Section\n\n- Item\n- Next\n");
	let page = await join("ana");
	await content(page).getByText("Section").click();
	await settle(page);
	await move(page, "Home");
	await page.keyboard.press("Backspace");
	await written(page, room, /^Intro\.\n\nSection\n\n/m);
	await page.keyboard.press("Backspace");
	await written(page, room, /^Intro\.Section$/m);

	await content(page).getByText("Next").click();
	await settle(page);
	await move(page, "Home");
	await page.keyboard.press("Backspace");
	await written(page, room, /^- Item\n\nNext\s*$/m);
});

test("Enter on an empty list item leaves the list, and Tab and Shift+Tab nest an item", async ({ join, room, seed }) => {
	await seed("- One\n- Two\n");
	let page = await join("ana");
	await content(page).getByText("Two").click();
	await settle(page);
	await move(page, "End");
	await page.keyboard.press("Tab");
	await written(page, room, /^- One\n {2,4}- Two\s*$/m);
	await page.keyboard.press("Shift+Tab");
	await written(page, room, /^- One\n- Two\s*$/m);
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("Out.");
	await written(page, room, /^- Two\n\nOut\.\s*$/m);
});

test("a collaborator's block moves and deletes while another person types in it", async ({ join, room, seed }) => {
	await seed("Alpha.\n\nBeta.\n\nGamma.\n");
	let ana = await join("ana");
	let bo = await join("bo");
	await content(bo).getByText("Beta.").click();
	await settle(bo);
	await move(bo, "End");
	await bo.keyboard.type(" Bo");

	await content(ana).getByText("Beta").click();
	await settle(ana);
	await ana.keyboard.press("Escape");
	await ana.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await written(ana, room, /^Beta\. Bo\n\nAlpha\.\n\nGamma\.\s*$/m);
	await bo.keyboard.type(" still here.");
	await expect(content(ana).getByText(/still here\./)).toBeVisible();
	await written(ana, room, /still here\./);

	// Deleting the block Bo is in leaves both documents the same and still editable.
	await content(bo).getByText("Gamma.").click();
	await settle(bo);
	await move(bo, "End");
	await content(ana).getByText("Gamma.").click();
	await settle(ana);
	await ana.keyboard.press("Escape");
	await ana.keyboard.press("Delete");
	await written(ana, room, /^(?![\s\S]*Gamma)[\s\S]*Alpha\.\s*$/);
	await expect(content(bo).getByText("Gamma.")).toHaveCount(0);
	await content(bo).getByText("Alpha.").click();
	await settle(bo);
	await move(bo, "End");
	await bo.keyboard.type(" Typed.");
	await written(ana, room, /Alpha\. Typed\.\s*$/);
});
