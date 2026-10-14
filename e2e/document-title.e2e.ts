import { content, edit, expect, ready, test, written } from "./room";

import type { Page } from "@playwright/test";

function title(page: Page) {
	return content(page).getByRole("heading", { level: 1 }).first();
}

async function selectTitle(page: Page, offset?: number) {
	await title(page).evaluate((heading, offset) => {
		let range = document.createRange();
		range.selectNodeContents(heading);
		if (offset !== undefined) {
			let walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
			let text = walker.nextNode()!;
			while (offset > (text.textContent?.length ?? 0)) {
				offset -= text.textContent?.length ?? 0;
				text = walker.nextNode()!;
			}
			range.setStart(text, offset);
			range.collapse(true);
		}
		let selection = getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		(heading.closest("[contenteditable]") as HTMLElement).focus();
	}, offset);
}

async function paste(page: Page, text: string, html?: string) {
	await content(page).evaluate((root, { text, html }) => {
		let data = new DataTransfer();
		data.setData("text/plain", text);
		if (html) data.setData("text/html", html);
		root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	}, { text, html });
}

test("clearing the title leaves its placeholder and ordinary body H1 intact", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n\n# Ordinary body heading\n");
	let page = await join("ana");
	await selectTitle(page);
	await page.keyboard.press("Backspace");
	await expect(title(page)).toHaveText("");
	await expect(title(page)).toHaveAttribute("data-document-title", "");
	await expect(title(page)).toHaveAttribute("data-document-title-empty", "");
	await expect(page.getByRole("group", { name: "Document: Untitled", exact: true })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Projects" })
			.locator('[aria-current="page"]'),
	).toHaveAccessibleName("Untitled");
	await expect(content(page).getByRole("heading", { name: "Ordinary body heading", exact: true }))
		.toBeVisible();
	await written(page, room, /^#\n\nBody prose\.\n\n# Ordinary body heading\n$/);
	await page.screenshot({ path: "/private/tmp/chopin-title-placeholder.png" });
	await page.reload();
	await ready(page);
	await expect(title(page)).toHaveText("");
});

test("Enter anywhere in the title preserves it and enters body prose", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	for (let offset of [0, 4, 14]) {
		await selectTitle(page, offset);
		await page.keyboard.press("Enter");
		await page.keyboard.type(`Body ${offset}.`);
		await expect(title(page)).toHaveText("Original title");
		await expect(content(page).locator("p").filter({ hasText: `Body ${offset}.` })).toBeVisible();
	}
	await written(page, room, /^# Original title\n/);
});

test("typing and rich paste bound titles by Unicode characters", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	await selectTitle(page);
	await page.keyboard.type("Two words");
	await expect(title(page)).toHaveText("Two words");
	await selectTitle(page);
	await page.keyboard.type("a".repeat(51));
	await expect(title(page)).toHaveText("a".repeat(50));
	await selectTitle(page);
	await paste(page, "😀".repeat(51), `<h2>${"😀".repeat(51)}</h2><p>Extra</p>`);
	await expect(title(page)).toHaveText("😀".repeat(50));
	await expect(content(page).getByRole("heading", { level: 2 })).toHaveCount(0);
	await written(page, room, `# ${"😀".repeat(50)}\n`);
	await selectTitle(page);
	await paste(page, "New\nname");
	await expect(title(page)).toHaveText("New name");
});

test("title undo and peer editing converge without resets and retain historical URLs", async ({ join, seed, room, page }) => {
	await seed("# Original title\n\nBody prose.\n");
	let resets = 0;
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string" && payload.includes('"kind":"plan:reset"')) resets++;
		}));
	let ana = await join("ana");
	let original = ana.url();
	let bo = await join("bo");
	await selectTitle(ana);
	await ana.keyboard.press("Backspace");
	await expect(title(bo)).toHaveText("");
	await ana.keyboard.press("ControlOrMeta+z");
	await expect(title(ana)).toHaveText("Original title");
	await expect(title(bo)).toHaveText("Original title");
	await ana.keyboard.press("ControlOrMeta+Shift+z");
	await expect(title(bo)).toHaveText("");
	await selectTitle(bo);
	await bo.keyboard.type("Peer name");
	await expect(title(ana)).toHaveText("Peer name");
	await written(ana, room, /^# Peer name\n/);
	await expect(ana).toHaveURL(/peer-name/);
	await expect(ana.getByRole("group", { name: "Document: Peer name", exact: true })).toBeVisible();
	await expect(
		ana.getByRole("complementary", { name: "Projects" })
			.locator('[aria-current="page"]'),
	).toHaveAccessibleName("Peer name");
	await ana.screenshot({ path: "/private/tmp/chopin-document-title.png" });
	await ana.goto(original);
	await ready(ana);
	await expect(title(ana)).toHaveText("Peer name");
	await expect(ana).toHaveURL(/peer-name/);
	expect(resets).toBe(0);
});

test("a phone keeps the semantic title while editing it", async ({ join, seed }) => {
	await seed("# Phone title\n\nBody prose.\n");
	let page = await join("ana", {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	await edit(page);
	await selectTitle(page);
	await page.keyboard.type("Renamed phone title");
	await expect(title(page)).toHaveText("Renamed phone title");
	await expect(title(page)).toBeVisible();
});

test("an empty document opens with a body caret and keeps its generated title", async ({ join, room }) => {
	let page = await join("ana");
	let name = await title(page).textContent();
	await content(page).click();
	await page.keyboard.type("First body prose.");
	await expect(title(page)).toHaveText(name!);
	await expect(content(page).locator("p").filter({ hasText: "First body prose." })).toBeVisible();
	await written(page, room, "First body prose.");
});

test("body-start deletion and select-all replacement retain the protected title", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	await content(page).locator("p").first().evaluate(paragraph => {
		let range = document.createRange();
		range.selectNodeContents(paragraph);
		range.collapse(true);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(range);
		(paragraph.closest("[contenteditable]") as HTMLElement).focus();
	});
	await page.keyboard.press("Backspace");
	await expect(title(page)).toHaveText("Original title");
	await expect(content(page).locator("p").first()).toHaveText("Body prose.");
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type("Replacement");
	await expect(title(page)).toHaveCount(1);
	await expect(title(page)).toHaveAttribute("data-document-title", "");
	await written(page, room, "Replacement");
});

test("the toolbar cannot turn the title into prose or an ordinary heading", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	for (let kind of ["Text", "Heading 2"]) {
		await selectTitle(page);
		let toolbar = page.getByRole("toolbar", { name: "Text formatting" });
		await toolbar.getByRole("button", { name: "Block type: Heading 1" }).click();
		await toolbar.getByRole("button", { name: kind, exact: true }).click();
		await expect(title(page)).toHaveText("Original title");
		await expect(content(page).getByRole("heading", { level: 2 })).toHaveCount(0);
	}
	await written(page, room, /^# Original title\n\nBody prose\.\n$/);
});

test("title list-format actions preserve body lists and leave editing usable", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n\n- Preserved body item\n");
	let page = await join("ana");
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	page.on("console", message => {
		if (message.type() === "error" && message.text().includes("endlessly")) {
			errors.push(message.text());
		}
	});
	for (let kind of ["Bulleted list", "Numbered list"]) {
		await selectTitle(page);
		let toolbar = page.getByRole("toolbar", { name: "Text formatting" });
		await toolbar.getByRole("button", { name: "Block type: Heading 1" }).click();
		await toolbar.getByRole("button", { name: kind, exact: true }).click();
		await expect(title(page)).toHaveText("Original title");
		await expect(content(page).getByRole("listitem")).toHaveCount(1);
		await expect(content(page).getByRole("listitem")).toHaveText("Preserved body item");
	}
	await selectTitle(page, 14);
	await page.keyboard.type(" updated");
	await expect(title(page)).toHaveText("Original title updated");
	await written(
		page,
		room,
		/^# Original title updated\n\nBody prose\.\n\n- Preserved body item\n$/,
	);
	expect(errors).toEqual([]);
});

test("a range deletion across the title boundary keeps unselected body prose separate", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	await content(page).evaluate(root => {
		let heading = root.querySelector("h1")!;
		let body = root.querySelector("p")!;
		let titleText = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT).nextNode()!;
		let bodyText = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!;
		let range = document.createRange();
		range.setStart(titleText, 8);
		range.setEnd(bodyText, 5);
		getSelection()!.removeAllRanges();
		getSelection()!.addRange(range);
		(root as HTMLElement).focus();
	});
	await page.keyboard.press("Backspace");
	await expect(title(page)).toHaveText("Original");
	await expect(content(page).locator("p").first()).toHaveText("prose.");
	await written(page, room, /^# Original\n\nprose\.\n$/);
});

test("manual rename accepts 50 Unicode characters and projects the authored title", async ({ join, seed, room }) => {
	await seed("# Original title\n\nBody prose.\n");
	let page = await join("ana");
	await page.getByRole("group", { name: "Document: Original title", exact: true })
		.getByRole("button", { name: "Rename Original title", exact: true }).click();
	let field = page.getByRole("textbox", { name: "Document title" });
	await field.fill("😀".repeat(51));
	await expect(field).toHaveValue("😀".repeat(50));
	await field.press("Enter");
	await expect(title(page)).toHaveText("😀".repeat(50));
	await written(page, room, `# ${"😀".repeat(50)}\n\nBody prose.\n`);
});
