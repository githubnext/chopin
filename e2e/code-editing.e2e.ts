/**
 * A code block is edited where it is read, as Notion's is: its text is coloured in place, so a click
 * puts the caret in the coloured code and typing keeps its colours. The keys are a code editor's
 * inside it (Enter is a line, Tab indents) and a document's at its edges (arrows, Escape and
 * Mod+Enter leave it, Backspace in an empty one makes it a paragraph again).
 */

import { content, edit, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const MENU = { name: "Insert block" };

/** The source's colours, as the page paints them: how many ranges each role has. */
async function painted(page: Page): Promise<Record<string, number>> {
	return await page.evaluate(() => {
		let counts: Record<string, number> = {};
		for (let [name, highlight] of CSS.highlights) {
			if (name.startsWith("plan-code-") && highlight.size) counts[name] = highlight.size;
		}
		return counts;
	});
}

/** The text a role's ranges cover, in order. */
async function paintedText(page: Page, role: string): Promise<string[]> {
	return await page.evaluate(name => {
		let highlight = CSS.highlights.get(name);
		return [...highlight ?? []].map(range => range.toString());
	}, `plan-code-${role}`);
}

/**
 * Put the caret just after `text` in the code, and wait for the editor to have it there: a click
 * lands wherever the line's box puts it, and the keys after it need to know where they start.
 */
async function caretAfter(page: Page, text: string) {
	await content(page).locator(".planCode [data-plan-source]").evaluate((source, find) => {
		let walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let at = node.textContent!.indexOf(find);
			if (at === -1) continue;
			(source.closest("[contenteditable]") as HTMLElement).focus();
			getSelection()!.collapse(node, at + find.length);
			return;
		}
		throw new Error(`no ${find} in the code`);
	}, text);
	// The editor reads the selection from the next selectionchange.
	await page.waitForTimeout(50);
}

async function codeBlock(page: Page) {
	await content(page).click();
	await page.keyboard.type("/code");
	await page.getByRole("listbox", MENU).getByRole("option", { name: "Code block" }).click();
}

test("named code is coloured where it is edited, and stays coloured as it is typed", async ({ join, room, seed }) => {
	await seed('```ts\nconst a = "one";\n```\n');
	let page = await join("ana");
	let block = content(page).locator(".planCode");

	// One surface: the source is the coloured text, with no second copy and no toggle.
	await expect(block.locator("[data-plan-source]")).toBeVisible();
	await expect(block.getByRole("button", { name: "Show source" })).toHaveCount(0);
	await expect(block.locator("[data-file]")).toHaveCount(0);
	await expect.poll(() => paintedText(page, "keyword")).toContain("const");
	await expect.poll(async () =>
		[
			...await paintedText(page, "string"),
			...await paintedText(page, "string-expression"),
		].join("")
	).toContain("one");

	await block.getByText("const a").click();
	await caretAfter(page, '"one";');
	await page.keyboard.press("Enter");
	await page.keyboard.type("let b = 2;");
	await written(page, room, /^const a = "one";\nlet b = 2;$/m);
	await expect.poll(() => paintedText(page, "keyword")).toContain("let");
	expect(Object.keys(await painted(page)).length).toBeGreaterThan(1);
});

test("the language menu changes the colours at once", async ({ join, seed }) => {
	await seed("```typescript\ndef run(): pass\n```\n");
	let page = await join("ana");
	let block = content(page).locator(".planCode");
	await expect.poll(() => paintedText(page, "keyword")).not.toContain("def");

	await block.hover();
	await block.getByRole("button", { name: "Code language: TypeScript" }).click();
	await page.getByRole("option", { name: "Python", exact: true }).click();
	await expect.poll(() => paintedText(page, "keyword")).toContain("def");
});

test("Enter is always a new line, and Mod+Enter leaves the block", async ({ join, room }) => {
	let page = await join("ana");
	await codeBlock(page);
	await page.keyboard.type("a();");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("b();");
	await written(page, room, /```\na\(\);\n\n\nb\(\);\n```/);

	await page.keyboard.press("ControlOrMeta+Enter");
	await page.keyboard.type("After.");
	await written(page, room, /b\(\);\n```\n\nAfter\.$/m);
});

test("Escape and the arrows at its end leave the block, ArrowUp at its start goes above", async ({ join, room, seed }) => {
	await seed("Before.\n\n```ts\nlet a = 1;\nlet b = 2;\n```\n");
	let page = await join("ana");

	await caretAfter(page, "let b = 2;");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.type("Down.");
	await written(page, room, /let b = 2;\n```\n\nDown\.$/m);

	await caretAfter(page, "let b");
	await page.keyboard.press("Escape");
	await page.keyboard.type("Esc ");
	await written(page, room, /```\n\nEsc Down\.$/m);

	await caretAfter(page, "let");
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("End");
	await page.keyboard.type(" Up");
	await written(page, room, /^Before\. Up$/m);

	await caretAfter(page, "let b = 2;");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type("Right ");
	await written(page, room, /```\n\nRight Esc Down\.$/m);
});

test("Tab and Shift+Tab indent and outdent every selected line", async ({ join, room, seed }) => {
	await seed("```ts\none();\ntwo();\nthree();\n```\n");
	let page = await join("ana");
	let block = content(page).locator(".planCode");

	await block.getByText("one();").click();
	await caretAfter(page, "one");
	await page.keyboard.press("Home");
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+End");
	await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("one();\ntwo();");
	await page.waitForTimeout(50);
	await page.keyboard.press("Tab");
	await written(page, room, /^\tone\(\);\n\ttwo\(\);\nthree\(\);$/m);

	// The lines stay selected, so a second press indents them again.
	await page.keyboard.press("Tab");
	await written(page, room, /^\t\tone\(\);\n\t\ttwo\(\);\nthree\(\);$/m);
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await written(page, room, /^one\(\);\ntwo\(\);\nthree\(\);$/m);
});

test("Mod+A selects the block's code, then the document", async ({ join, seed }) => {
	await seed("Before.\n\n```ts\nlet a = 1;\nlet b = 2;\n```\n\nAfter.\n");
	let page = await join("ana");
	await caretAfter(page, "let a");
	await page.keyboard.press("ControlOrMeta+A");
	expect(await page.evaluate(() => getSelection()?.toString())).toBe("let a = 1;\nlet b = 2;");
	await page.keyboard.press("ControlOrMeta+A");
	await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toContain("Before.");
});

test("Backspace in an empty block makes it a paragraph", async ({ join, room }) => {
	let page = await join("ana");
	await codeBlock(page);
	await page.keyboard.type("x");
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");
	await expect(content(page).locator(".planCode")).toHaveCount(0);
	await page.keyboard.type("Prose again.");
	await written(page, room, /^Prose again\.$/m);
});

test("``` and a language, then Enter or Space, makes a code block", async ({ join, room }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("```python");
	await page.keyboard.press("Enter");
	await page.keyboard.type("def run():");
	await written(page, room, /^```python\ndef run\(\):\n```$/m);

	await page.keyboard.press("ControlOrMeta+Enter");
	await page.keyboard.type("``` ");
	await page.keyboard.type("plain");
	await written(page, room, /^```\nplain\n```$/m);
});

test("a paste into code keeps its text and indentation exactly", async ({ context, join, room, seed }) => {
	await seed("```ts\nstart\n```\n");
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	let page = await join("ana");
	await caretAfter(page, "start");
	let pasted = '\nif (a) {\n\t  b("**not bold**");\n    // - not a list\n}\n# not a heading';
	await page.evaluate(text => navigator.clipboard.writeText(text), pasted);
	await page.keyboard.press("ControlOrMeta+V");
	await written(page, room, "```ts\nstart" + pasted + "\n```");
});

test("Wrap lines wraps the coloured source in place", async ({ join, room, seed }) => {
	let long = `const value = "${"word ".repeat(40).trim()}";`;
	await seed(`\`\`\`ts\n${long}\n\`\`\`\n`);
	let page = await join("ana");
	let block = content(page).locator(".planCode");
	let source = block.locator("[data-plan-source]");
	await expect.poll(() => source.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);

	await block.hover();
	await block.getByRole("button", { name: "Wrap lines" }).click();
	await written(page, room, /^```ts wrap$/m);
	await expect.poll(() => source.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
	await expect.poll(() => paintedText(page, "keyword")).toContain("const");
});

test("two people typing in one coloured block both see each other's text", async ({ join, room, seed }) => {
	await seed("```ts\nlet a = 1;\n```\n");
	let ana = await join("ana");
	let bo = await join("bo");

	await caretAfter(ana, "1;");
	await ana.keyboard.type(" // ana");
	await expect(content(bo).locator(".planCode [data-plan-source]")).toHaveText("let a = 1; // ana");
	await caretAfter(bo, "");
	await bo.keyboard.type("const z = 0; ");

	for (let page of [ana, bo]) {
		await expect(content(page).locator(".planCode [data-plan-source]")).toHaveText(
			"const z = 0; let a = 1; // ana",
		);
		await expect.poll(() => paintedText(page, "keyword")).toEqual(
			expect.arrayContaining(["const", "let"]),
		);
		await expect.poll(() => paintedText(page, "comment")).toEqual(["// ana"]);
	}
	await written(ana, room, /^const z = 0; let a = 1; \/\/ ana$/m);
});

test("typing goes into code that is indented with tabs, coloured or plain text", async ({ join, room, seed }) => {
	await seed(
		"```typescript\nfunction run() {\n\treturn 1;\n}\n```\n\n```text\n+--+\n\t| a |\n```\n",
	);
	let page = await join("ana");
	await expect.poll(() => paintedText(page, "keyword")).toContain("return");

	for (let [block, line] of [[0, 0], [1, 0]] as const) {
		let source = content(page).locator(".planCode").nth(block).locator("[data-plan-source]");
		// Where a person clicks, into the first line of each.
		let box = (await source.boundingBox())!;
		await page.mouse.click(box.x + 40, box.y + 12 + line * 20);
		await page.keyboard.press("End");
		await page.keyboard.type(" // typed");
	}
	await written(page, room, /^function run\(\) \{ \/\/ typed\n\treturn 1;$/m);
	await written(page, room, /^\+--\+ \/\/ typed\n\t\| a \|$/m);
});

test("keys in code or an open rendered source right after a press act on the block pressed, on a desktop and a phone", async ({ join, room, seed }) => {
	await seed(
		[
			"# Title",
			"",
			"Before.",
			"",
			"```ts",
			"let a = 1;",
			"```",
			"",
			"After.",
			"",
			"```diff",
			"--- a/x.ts",
			"+++ b/x.ts",
			"@@ -1,3 +1,3 @@",
			" export function open() {",
			"-	return 1;",
			"+	return 2;",
			" }",
			"```",
			"",
			"```",
			"```",
			"",
		].join("\n"),
	);
	let page = await join("ana");
	let tsCode = content(page).locator(".planCode").nth(0);
	let diffCode = content(page).locator(".planCode").nth(1);
	let emptyCode = content(page).locator(".planCode").nth(2);
	let diffPreview = diffCode.getByRole("group", { name: "Diff preview" });
	await expect(diffPreview).toBeVisible();

	let parkInBefore = async (target: Page) => {
		let box = (await content(target).getByText("Before.", { exact: true }).boundingBox())!;
		await target.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
		await target.waitForTimeout(50);
	};

	// Press into code, then Escape at once: leaves the code block rather than block-selecting it.
	await parkInBefore(page);
	let tsBox = (await tsCode.locator("[data-plan-source]").boundingBox())!;
	await page.mouse.click(tsBox.x + 24, tsBox.y + 12);
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-block-selected]")).toHaveCount(0);
	await page.keyboard.type("Mid. ");
	await written(page, room, /^let a = 1;\n```\n\nMid\. After\.$/m);

	// Press into code, then Mod+Enter and Mod+A at once act on the code block, not the whole document.
	await parkInBefore(page);
	await page.mouse.click(tsBox.x + 24, tsBox.y + 12);
	await page.keyboard.press("ControlOrMeta+Enter");
	await page.keyboard.type("Next. ");
	await written(page, room, /^let a = 1;\n```\n\nNext\. Mid\. After\.$/m);

	await parkInBefore(page);
	await page.mouse.click(tsBox.x + 24, tsBox.y + 12);
	await page.keyboard.press("ControlOrMeta+a");
	await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("let a = 1;");

	// Pinned diff source open: press into it, then Escape at once folds it and focuses its preview.
	await diffCode.getByRole("button", { name: "Show source" }).click();
	await expect(diffCode.locator("[data-plan-source]")).toBeVisible();
	await diffCode.locator("[data-plan-source]").scrollIntoViewIfNeeded();
	await parkInBefore(page);
	let diffSourceBox = (await diffCode.locator("[data-plan-source]").boundingBox())!;
	await page.mouse.click(diffSourceBox.x + 24, diffSourceBox.y + 12);
	await page.keyboard.press("Escape");
	await expect(diffCode.locator("[data-plan-source]")).toBeHidden();
	await expect(diffPreview).toBeFocused();

	// Source open with caret inside: press into prose, then Escape at once selects the prose block.
	await page.keyboard.press("Enter");
	await expect(diffCode.locator("[data-plan-source]")).toBeVisible();
	await page.waitForTimeout(50);
	let beforeBox = (await content(page).getByText("Before.", { exact: true }).boundingBox())!;
	await page.mouse.click(beforeBox.x + 16, beforeBox.y + 8);
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-block-selected]")).toHaveText("Before.");
	await page.keyboard.press("Escape");

	// Empty code block: press into it, then Backspace at once turns it into a paragraph without touching Before.
	await emptyCode.locator("[data-plan-source]").scrollIntoViewIfNeeded();
	await parkInBefore(page);
	let emptyBox = (await emptyCode.locator("[data-plan-source]").boundingBox())!;
	await page.mouse.click(emptyBox.x + 24, emptyBox.y + 12);
	await page.keyboard.press("Backspace");
	await expect(content(page).locator(".planCode")).toHaveCount(2);
	await expect(content(page).getByText("Before.", { exact: true })).toBeVisible();

	// Phone (390x844 touch): Edit document parks Lexical on the title; tap + Escape/Enter/Tab act on the tapped block.
	let phone = await join("bo", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	await edit(phone);
	let phoneTs = content(phone).locator(".planCode").nth(0);
	let phoneDiff = content(phone).locator(".planCode").nth(1);
	let phoneTsBox = (await phoneTs.locator("[data-plan-source]").boundingBox())!;
	await phone.touchscreen.tap(phoneTsBox.x + 24, phoneTsBox.y + 12);
	await phone.keyboard.press("Escape");
	await expect(phone.locator("[data-block-selected]")).toHaveCount(0);
	await expect(content(phone)).toBeFocused();

	await phoneDiff.getByRole("button", { name: "Show source" }).tap();
	await expect(phoneDiff.locator("[data-plan-source]")).toBeVisible();
	let titleBox = (await content(phone).locator("h1").first().boundingBox())!;
	await phone.touchscreen.tap(titleBox.x + 20, titleBox.y + 12);
	await phone.waitForTimeout(50);
	let phoneDiffBox = (await phoneDiff.locator("[data-plan-source]").boundingBox())!;
	await phone.touchscreen.tap(phoneDiffBox.x + 24, phoneDiffBox.y + 12);
	await phone.keyboard.press("Escape");
	await expect(phoneDiff.locator("[data-plan-source]")).toBeHidden();
	await expect(phoneDiff.getByRole("group", { name: "Diff preview" })).toBeFocused();

	await phone.touchscreen.tap(titleBox.x + 20, titleBox.y + 12);
	await phone.waitForTimeout(50);
	phoneTsBox = (await phoneTs.locator("[data-plan-source]").boundingBox())!;
	await phone.touchscreen.tap(phoneTsBox.x + 6, phoneTsBox.y + 12);
	await phone.keyboard.press("Tab");
	await phone.keyboard.press("Enter");
	await expect(content(phone)).toBeFocused();
	await written(phone, room, /^\t\nlet a = 1;$/m);
});
