/**
 * Notion's block keys and menu: the slash menu's basic blocks, `---` for a divider, a block moved
 * with Mod+Shift+arrows and copied with Mod+D, and Mod+E for inline code.
 */

import { content, expect, test, written } from "./room";

const MENU = { name: "Insert block" };

test("the slash menu offers the basic blocks first, as Notion's does", async ({ join, room }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("/");
	let options = page.getByRole("listbox", MENU).getByRole("option");
	await expect(options.first()).toHaveAccessibleName("Text");
	expect((await options.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))
		.slice(0, 8)).toEqual([
			"Text",
			"Heading 1",
			"Heading 2",
			"Heading 3",
			"Bulleted list",
			"Numbered list",
			"Quote",
			"Divider",
		]);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Backspace");

	for (
		let [query, choice, typed] of [
			["/h2", "Heading 2", "Section"],
			["/numbered", "Numbered list", "First"],
		] as const
	) {
		await page.keyboard.type(query);
		await page.getByRole("listbox", MENU).getByRole("option", { name: choice }).click();
		await page.keyboard.type(typed);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
	}
	await page.keyboard.type("/divider");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Divider" }).click();
	await page.keyboard.type("After the line.");
	await written(page, room, /^## Section\n\n1\. First\n\n---\n\nAfter the line\.$/m);
});

test("--- on an empty line draws a divider", async ({ join, room, seed }) => {
	await seed("Before.\n");
	let page = await join("ana");
	await content(page).getByText("Before.").click();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("---");
	await page.keyboard.type("After.");
	await expect(content(page).locator("hr")).toHaveCount(1);
	await written(page, room, /^Before\.\n\n---\n\nAfter\.$/m);
});

test("Mod+Shift+ArrowUp and ArrowDown move the block, and Mod+D copies it", async ({ join, room, seed }) => {
	await seed("One.\n\nTwo.\n\nThree.\n");
	let page = await join("ana");
	await content(page).getByText("Three.").click();

	await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
	await written(page, room, /^Three\.\n\nOne\.\n\nTwo\.$/m);
	await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
	await written(page, room, /^One\.\n\nThree\.\n\nTwo\.$/m);

	await page.keyboard.press("ControlOrMeta+d");
	await page.keyboard.type(" Again.");
	await written(page, room, /^One\.\n\nThree\.\n\nThree\. Again\.\n\nTwo\.$/m);
});

test("Mod+E makes the selection inline code", async ({ join, room, seed }) => {
	await seed("Run make build now.\n");
	let page = await join("ana");
	await content(page).getByText("Run make build now.").click();
	await content(page).getByText("Run make build now.").evaluate(element => {
		let text = element.firstChild!;
		getSelection()!.setBaseAndExtent(text, 4, text, 14);
	});
	await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("make build");
	// The editor reads the selection from the next selectionchange.
	await page.waitForTimeout(50);
	await page.keyboard.press("ControlOrMeta+e");
	await written(page, room, /^Run `make build` now\.$/m);
});
