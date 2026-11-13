/**
 * Notion's block keys and menu: the slash menu's basic blocks, `---` for a divider, a block moved
 * with Mod+Shift+arrows and copied with Mod+D, and Mod+E for inline code.
 */

import { content, edit, expect, test, written } from "./room";

const MENU = { name: "Insert block" };

test("the slash menu offers the basic blocks first, as Notion's does", async ({ join, room }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("/");
	let options = page.getByRole("listbox", MENU).getByRole("option");
	await expect(options.first()).toHaveAccessibleName("Text");
	expect((await options.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))
		.slice(0, 9)).toEqual([
			"Text",
			"Heading 1",
			"Heading 2",
			"Heading 3",
			"Bulleted list",
			"Numbered list",
			"Task list",
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

test("block, list and table keys right after a press act on the block pressed, on a desktop and a phone", async ({ join, room, seed }) => {
	await seed(
		[
			"# Title",
			"",
			"One.",
			"",
			"Two.",
			"",
			"## Section",
			"",
			"- First",
			"- Second",
			"- Third",
			"",
			"| Col A | Col B |",
			"| --- | --- |",
			"| left | right |",
			"",
		].join("\n"),
	);
	let page = await join("ana");

	let parkInOne = async () => {
		let box = (await content(page).getByText("One.", { exact: true }).boundingBox())!;
		await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
		await page.waitForTimeout(50);
	};

	// Mod+Shift+ArrowDown right after clicking Two moves Two, not One.
	await parkInOne();
	let twoBox = (await content(page).getByText("Two.", { exact: true }).boundingBox())!;
	await page.mouse.click(twoBox.x + 12, twoBox.y + 8);
	await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
	await written(page, room, /^One\.\n\n## Section\n\nTwo\.$/m);

	// Backspace right after clicking the start of Heading 2 unformats the heading without deleting from One.
	await parkInOne();
	let headingPos = await content(page).getByRole("heading", { name: "Section" }).evaluate(el => {
		let range = document.createRange();
		let text = el.firstChild!;
		range.setStart(text, 0);
		range.setEnd(text, 1);
		let rect = range.getBoundingClientRect();
		return { x: rect.left + 1, y: rect.top + rect.height / 2 };
	});
	await page.mouse.click(headingPos.x, headingPos.y);
	await page.keyboard.press("Backspace");
	await written(page, room, /^One\.\n\nSection\n\nTwo\.$/m);

	// Tab right after clicking Second nests Second under First instead of leaving the editor.
	await parkInOne();
	let secondBox = (await content(page).getByText("Second", { exact: true }).boundingBox())!;
	await page.mouse.click(secondBox.x + 12, secondBox.y + 8);
	await page.keyboard.press("Tab");
	await expect(content(page)).toBeFocused();
	await written(page, room, /^- First\n  - Second\n- Third$/m);

	// Tab right after clicking a table cell moves to the next cell instead of leaving the editor.
	await parkInOne();
	let cellBox = (await content(page).getByRole("cell", { name: "left" }).boundingBox())!;
	await page.mouse.click(cellBox.x + 14, cellBox.y + 10);
	await page.keyboard.press("Tab");
	await page.keyboard.type("!");
	await written(page, room, /\| left\s*\| right!\s*\|/);

	// Phone (390x844 touch): Edit document parks Lexical on the title; tap + Mod+D and tap + Tab act on the tapped block.
	let phone = await join("bo", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	await edit(phone);
	let phoneTwo = (await content(phone).getByText("Two.", { exact: true }).boundingBox())!;
	await phone.touchscreen.tap(phoneTwo.x + 12, phoneTwo.y + 8);
	await phone.keyboard.press("ControlOrMeta+d");
	await written(phone, room, /^Two\.\n\nTwo\.$/m);

	let titleBox = (await content(phone).locator("h1").first().boundingBox())!;
	await phone.touchscreen.tap(titleBox.x + 20, titleBox.y + 12);
	await phone.waitForTimeout(50);
	let phoneThird = (await content(phone).getByText("Third", { exact: true }).boundingBox())!;
	await phone.touchscreen.tap(phoneThird.x + 12, phoneThird.y + 8);
	await phone.keyboard.press("Tab");
	await expect(content(phone)).toBeFocused();
	await written(phone, room, /^- First\n  - Second\n  - Third$/m);
});
