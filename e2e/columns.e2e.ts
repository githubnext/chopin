import { readFileSync } from "node:fs";

import { content, expect, ready, test, written } from "./room";

import type { WebSocketRoute } from "@playwright/test";

const DOCUMENT_IMAGE = readFileSync(new URL("./fixtures/gallery-document.svg", import.meta.url));
const LAYOUT_IMAGE = readFileSync(new URL("./fixtures/gallery-layout.svg", import.meta.url));

const SOURCE = `<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">

First gallery note.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

Second gallery note.

</Column>
</Columns>
`;

const GALLERY = `<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">

![First image](https://example.com/missing-first.png)

First caption.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

![Second image](https://example.com/missing-second.png)

Second caption.

</Column>
</Columns>
`;

const DISPLAY_GALLERY = `# A shared way to review

A document can hold ideas side by side while everyone keeps editing the same text.

## Visual references

<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">

![An open working document](https://example.com/gallery-document.svg)

A working document with related material kept together.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

![A spatial document layout](https://example.com/gallery-layout.svg)

Images and captions remain editable inside the document.

</Column>
</Columns>

The narrative continues after the layout.
`;

test("columns render side by side, stack in a narrow document, and unwrap in order", async ({ join, room, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await page.getByRole("button", { name: "Hide chat" }).click();
	await expect.poll(() =>
		page.locator(".plan-document").evaluate(element => element.getBoundingClientRect().width)
	).toBeGreaterThan(800);
	let columns = content(page).locator(".planColumns");
	let regions = columns.locator(".planColumn");
	await expect(regions).toHaveCount(2);
	let wide = await regions.evaluateAll(nodes =>
		nodes.map(node => {
			let box = node.getBoundingClientRect();
			return { x: box.x, y: box.y, right: box.right };
		})
	);
	expect(wide[1]!.x).toBeGreaterThan(wide[0]!.right);
	expect(Math.abs(wide[1]!.y - wide[0]!.y)).toBeLessThan(2);

	await page.setViewportSize({ width: 620, height: 850 });
	await expect.poll(async () => {
		let boxes = await regions.evaluateAll(nodes =>
			nodes.map(node => {
				let box = node.getBoundingClientRect();
				return { x: box.x, y: box.y, bottom: box.bottom };
			})
		);
		return boxes.length === 2 && Math.abs(boxes[1]!.x - boxes[0]!.x) < 2
			&& boxes[1]!.y > boxes[0]!.bottom;
	}).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

	await columns.hover();
	await content(page).getByRole("button", { name: "Unwrap columns" }).click();
	await expect(columns).toHaveCount(0);
	await written(page, room, /^First gallery note\.\n\nSecond gallery note\.\n$/);
	await content(page).getByText("First gallery note.").click();
	await page.keyboard.press("ControlOrMeta+z");
	await expect(columns).toHaveCount(1);
	await page.keyboard.press("ControlOrMeta+Shift+z");
	await expect(columns).toHaveCount(0);
	await page.reload();
	await expect(content(page).getByText("First gallery note.")).toBeVisible();
	await expect(content(page).getByText("Second gallery note.")).toBeVisible();
});

test("arrow navigation crosses from the first column to the second", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", { viewport: { width: 1600, height: 900 } });
	let first = content(page).locator(".planColumn").first().getByText("First gallery note.");
	await first.selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() =>
		page.evaluate(() => {
			let node = getSelection()?.anchorNode;
			let element = node instanceof Element ? node : node?.parentElement;
			let columns = [...document.querySelectorAll(".planColumn")];
			let column = element?.closest(".planColumn");
			return column ? columns.indexOf(column) : -1;
		})
	).toBe(1);
});

test("cut and paste keep content editable, and Enter leaves the second column", async ({ context, join, room, seed }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await seed(SOURCE);
	let page = await join("ana");
	let regions = content(page).locator(".planColumn");
	await regions.first().getByText("First gallery note.").selectText();
	await page.keyboard.press("ControlOrMeta+x");
	await expect(regions.first()).not.toContainText("First gallery note.");
	await written(page, room, /^(?![\s\S]*First gallery note\.)[\s\S]*Second gallery note\./);

	let second = regions.last().getByText("Second gallery note.");
	await second.selectText();
	await page.keyboard.press("ArrowRight");
	// Let the browser's selectionchange reach Lexical before the next keydown.
	await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
	await page.keyboard.press("Enter");
	await page.keyboard.press("ControlOrMeta+v");
	await expect(regions.last()).toContainText("First gallery note.");
	await regions.last().getByText("First gallery note.").selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(content(page).locator(":scope > .planColumns + p")).toHaveCount(1);
	await page.keyboard.type("After columns.");
	await written(page, room, /<\/Columns>\n\nAfter columns\.\n$/);
});

test("the slash command places the caret in the first editable column", async ({ join, room }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("/columns");
	await page.getByRole("option", { name: "Columns" }).click();
	let regions = content(page).locator(".planColumn");
	await expect(regions).toHaveCount(2);
	await page.keyboard.type("Written in the first column.");
	await expect(regions.first()).toContainText("Written in the first column.");
	await expect(regions.last()).not.toContainText("Written in the first column.");
	await written(page, room, /<Columns id="[A-Z0-9]{26}">[\s\S]*Written in the first column\./);
});

test("image metadata can be repaired in place and reaches another reader", async ({ join, room, seed }) => {
	await seed(GALLERY);
	let writer = await join("ana");
	let reader = await join("bo");
	let image = content(writer).locator(".planColumn [data-plan-src]").first();
	await image.hover();
	await image.getByRole("button", { name: "Edit image" }).click();
	let dialog = writer.getByRole("dialog", { name: "Edit image" });
	let url = dialog.getByRole("textbox", { name: "Image URL" });
	let alt = dialog.getByRole("textbox", { name: "Alternative text" });
	await expect(url).toBeFocused();
	await expect(url).toHaveValue("https://example.com/missing-first.png");
	await expect(alt).toHaveValue("First image");
	await url.fill("http://example.com/not-allowed.png");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog.getByRole("alert")).toContainText("https://");
	await expect(dialog).toBeVisible();
	await url.fill("https://example.com/repaired-first.png");
	await alt.fill("Repaired image");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
	await written(writer, room, /!\[Repaired image\]\(https:\/\/example\.com\/repaired-first\.png\)/);
	await expect(content(reader).locator(".planColumn [data-plan-src]").first())
		.toHaveAttribute("data-plan-src", "https://example.com/repaired-first.png");
	let second = content(writer).locator(".planColumn [data-plan-src]").last();
	await second.hover();
	await second.getByRole("button", { name: "Edit image" }).click();
	let secondDialog = writer.getByRole("dialog", { name: "Edit image" });
	await secondDialog.getByRole("textbox", { name: "Image URL" })
		.fill("https://example.com/repaired-second.png");
	await secondDialog.getByRole("textbox", { name: "Alternative text" }).fill("");
	await secondDialog.getByRole("button", { name: "Save" }).click();
	await written(writer, room, /!\[\]\(https:\/\/example\.com\/repaired-second\.png\)/);
	await expect(content(reader).locator(".planColumn [data-plan-src]").last())
		.toHaveAttribute("data-plan-src", "https://example.com/repaired-second.png");
	await writer.reload();
	await expect(content(writer).locator(".planColumn [data-plan-src]").first())
		.toHaveAttribute("data-plan-src", "https://example.com/repaired-first.png");
	await expect(content(writer).locator(".planColumn [data-plan-src]").last())
		.toHaveAttribute("data-plan-src", "https://example.com/repaired-second.png");
});

test("a two-image gallery keeps its ratio, captions, and responsive reading order", async ({
	join,
	page,
	seed,
}, testInfo) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.route("https://example.com/gallery-*.svg", route =>
		route.fulfill({
			contentType: "image/svg+xml",
			body: route.request().url().endsWith("document.svg") ? DOCUMENT_IMAGE : LAYOUT_IMAGE,
		}));
	await seed(DISPLAY_GALLERY);
	await join("ana");
	await page.getByRole("button", { name: "Hide chat" }).click();
	await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
	await expect.poll(() =>
		page.locator(".workspace-chat-panel").evaluate(element => element.getBoundingClientRect().width)
	).toBeLessThan(2);
	await expect.poll(() =>
		page.locator(".plan-document").evaluate(element => element.getBoundingClientRect().width)
	).toBeGreaterThan(800);
	let columns = content(page).locator(".planColumn");
	let images = columns.locator("img.plan-image");
	await expect(images).toHaveCount(2);
	await expect.poll(() =>
		images.evaluateAll(nodes =>
			nodes.map(node => ({
				complete: (node as HTMLImageElement).complete,
				naturalWidth: (node as HTMLImageElement).naturalWidth,
				naturalHeight: (node as HTMLImageElement).naturalHeight,
			}))
		)
	).toEqual([
		{ complete: true, naturalWidth: 480, naturalHeight: 360 },
		{ complete: true, naturalWidth: 480, naturalHeight: 360 },
	]);
	let wide = await images.evaluateAll(nodes =>
		nodes.map(node => {
			let box = node.getBoundingClientRect();
			return { width: box.width, height: box.height };
		})
	);
	expect(wide.every(box => Math.abs(box.width / box.height - 4 / 3) < 0.02)).toBe(true);
	await expect(columns.first()).toContainText(
		"A working document with related material kept together.",
	);
	await expect(columns.last()).toContainText(
		"Images and captions remain editable inside the document.",
	);
	await page.waitForTimeout(350);
	await page.screenshot({ path: testInfo.outputPath("gallery-wide.png") });

	await page.setViewportSize({ width: 620, height: 850 });
	await expect.poll(async () => {
		let boxes = await columns.evaluateAll(nodes =>
			nodes.map(node => {
				let box = node.getBoundingClientRect();
				return { x: box.x, y: box.y, bottom: box.bottom };
			})
		);
		return boxes.length === 2 && Math.abs(boxes[1]!.x - boxes[0]!.x) < 2
			&& boxes[1]!.y > boxes[0]!.bottom;
	}).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.setViewportSize({ width: 620, height: 1350 });
	await page.waitForTimeout(350);
	await page.screenshot({ path: testInfo.outputPath("gallery-narrow.png") });
});

test("columns survive a writer reconnect and keep both readers in sync", async ({ join, page, room, seed }) => {
	let sockets: WebSocketRoute[] = [];
	let offline = false;
	await page.routeWebSocket("**/ws?**", route => {
		if (offline) return route.close();
		route.connectToServer();
		sockets.push(route);
	});
	await seed(SOURCE);
	await join("ana");
	let reader = await join("bo");

	offline = true;
	await sockets.at(-1)!.close();
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	let second = content(reader).locator(".planColumn").last().getByText("Second gallery note.");
	await second.selectText();
	await reader.keyboard.press("ArrowRight");
	await reader.keyboard.type(" Reader edit.");
	await written(reader, room, /Second gallery note\. Reader edit\./);

	offline = false;
	await ready(page);
	expect(sockets.length).toBeGreaterThan(1);
	await expect(content(page).locator(".planColumn").last())
		.toContainText("Second gallery note. Reader edit.");
	let first = content(page).locator(".planColumn").first().getByText("First gallery note.");
	await first.selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type(" Writer edit.");
	await expect(content(reader).locator(".planColumn").first())
		.toContainText("First gallery note. Writer edit.");
	await written(page, room, /First gallery note\. Writer edit\./);
});
