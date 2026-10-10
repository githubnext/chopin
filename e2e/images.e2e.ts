import { readFileSync } from "node:fs";

import { content, expect, ready, test, written } from "./room";

import type { Page, WebSocketRoute } from "@playwright/test";

const IMAGE = readFileSync(new URL("./fixtures/gallery-document.svg", import.meta.url));
const IMAGE_URL = "https://example.com/image-controls.svg";
const SOURCE = `# Prototype review

#### A document worth inspecting

The image stays part of the shared document. Open it to inspect the details.

![An open working document](${IMAGE_URL})

Continue writing below the prototype.
`;

async function loadImage(page: Page) {
	await page.route(
		IMAGE_URL,
		route => route.fulfill({ contentType: "image/svg+xml", body: IMAGE }),
	);
}

function image(page: Page) {
	return content(page).getByRole("img", { name: "An open working document", exact: true });
}

async function width(page: Page) {
	return image(page).evaluate(element => element.getBoundingClientRect().width);
}

test("images open a keyboard-accessible lightbox and return focus on close", async ({
	join,
	page,
	seed,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await loadImage(page);
	await seed(SOURCE);
	await join("ana");
	await expect.poll(() =>
		image(page).evaluate(element => (element as HTMLImageElement).naturalWidth)
	)
		.toBe(480);
	await image(page).click();
	let preview = page.getByRole("dialog", { name: "Image preview", exact: true });
	await expect(preview).toBeVisible();
	await expect(preview.getByRole("img", { name: "An open working document", exact: true }))
		.toBeVisible();
	await expect(preview.getByRole("button", { name: "Close image preview", exact: true }))
		.toBeFocused();
	let fitted = await preview.getByRole("img").evaluate(element =>
		element.getBoundingClientRect().width
	);
	await preview.getByRole("button", { name: "Zoom in", exact: true }).click();
	await expect(preview.getByRole("button", { name: "Zoom out", exact: true })).toBeVisible();
	await expect.poll(() =>
		preview.getByRole("img").evaluate(element => element.getBoundingClientRect().width)
	)
		.toBeGreaterThan(fitted);
	await preview.getByRole("button", { name: "Zoom out", exact: true }).click();
	await page.screenshot({ path: testInfo.outputPath("image-lightbox.png") });
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);
	await expect(content(page).getByRole("button", { name: "View image", exact: true }))
		.toBeFocused();
	await page.keyboard.press("Enter");
	await expect(preview).toBeVisible();
	await preview.getByRole("button", { name: "Close image preview", exact: true }).click();
	await expect(preview).toHaveCount(0);
});

test("the metadata dialog is centered and bounded by a narrow viewport", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 620, height: 850 });
	await loadImage(page);
	await seed(SOURCE);
	await join("ana");
	await image(page).hover();
	await content(page).getByRole("button", { name: "Edit image", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Edit image", exact: true });
	await expect(dialog.getByRole("textbox", { name: "Image URL", exact: true })).toBeFocused();
	let box = await dialog.boundingBox();
	expect(box).not.toBeNull();
	expect(Math.abs(box!.x + box!.width / 2 - 310)).toBeLessThan(2);
	expect(Math.abs(box!.y + box!.height / 2 - 425)).toBeLessThan(2);
	expect(box!.width).toBeLessThan(620);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});

test(
	"corner resizing preserves aspect ratio, synchronizes, survives reload, and can reset",
	async ({
		join,
		page,
		room,
		seed,
	}, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await loadImage(page);
		await seed(SOURCE);
		await join("ana");
		let reader = await join("bo", { viewport: { width: 1440, height: 900 } });
		await loadImage(reader);
		await reader.reload();
		await ready(reader);
		await expect.poll(() => width(page)).toBe(480);
		await image(page).hover();
		let corner = content(page).getByRole("slider", {
			name: "Resize image from bottom right",
			exact: true,
		});
		let handle = await corner.boundingBox();
		expect(handle).not.toBeNull();
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(handle!.x - 80, handle!.y - 60, { steps: 4 });
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await expect.poll(() => width(page)).toBe(480);
		await written(
			page,
			room,
			"![An open working document](https://example.com/image-controls.svg)",
		);
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(
			handle!.x + handle!.width / 2 - 120,
			handle!.y + handle!.height / 2 - 90,
			{
				steps: 8,
			},
		);
		await expect.poll(() => width(page)).toBeLessThan(400);
		await expect.poll(() => width(reader)).toBe(480);
		let resized = Math.round(await width(page));
		await page.mouse.up();
		await expect.poll(() => width(page)).toBeCloseTo(resized, 0);
		await written(page, room, new RegExp(`width="${resized}"`));
		await expect.poll(() => width(reader)).toBeCloseTo(resized, 0);
		let ratio = await image(page).evaluate(element => {
			let box = element.getBoundingClientRect();
			return box.width / box.height;
		});
		expect(ratio).toBeCloseTo(4 / 3, 2);
		await page.reload();
		await ready(page);
		await expect.poll(() => width(page)).toBeCloseTo(resized, 0);
		await image(page).hover();
		await expect(content(page).getByRole("group", { name: "Image controls", exact: true }))
			.toHaveCSS("opacity", "1");
		await content(page).screenshot({ path: testInfo.outputPath("image-inline-controls.png") });
		await content(page).getByRole("button", { name: "Reset image size", exact: true }).click();
		await written(
			page,
			room,
			"![An open working document](https://example.com/image-controls.svg)",
		);
		await expect.poll(() => width(reader)).toBe(480);
	},
);

test("linked images can grow within the paragraph and still open a preview", async ({ join, page, room, seed }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await loadImage(page);
	await seed(`[![An open working document](${IMAGE_URL})](https://example.com/details)\n`);
	await join("ana");
	await page.getByRole("button", { name: "Hide chat", exact: true }).click();
	await expect.poll(() => width(page)).toBe(480);
	await image(page).hover();
	let corner = content(page).getByRole("slider", {
		name: "Resize image from bottom right",
		exact: true,
	});
	await corner.focus();
	await corner.press("ArrowRight");
	await written(page, room, /width="490"/);
	await expect.poll(() => width(page)).toBe(490);
	let before = page.url();
	await image(page).click();
	await expect(page.getByRole("dialog", { name: "Image preview", exact: true })).toBeVisible();
	expect(page.url()).toBe(before);
	await page.keyboard.press("Escape");
});

test("keyboard resizing is undoable and stored widths stay inside narrow documents", async ({ join, page, room, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await loadImage(page);
	await seed(SOURCE);
	await join("ana");
	await image(page).hover();
	let corner = content(page).getByRole("slider", {
		name: "Resize image from bottom right",
		exact: true,
	});
	await corner.focus();
	await corner.press("ArrowLeft");
	await written(page, room, /width="470"/);
	await corner.press("ControlOrMeta+z");
	await written(page, room, "![An open working document](https://example.com/image-controls.svg)");
	await corner.press("ArrowLeft");
	await written(page, room, /width="470"/);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(() =>
		image(page).evaluate(element => {
			let box = element.getBoundingClientRect();
			return box.right <= innerWidth && box.width < 390;
		})
	).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.reload();
	await ready(page);
	await expect.poll(() => width(page)).toBeLessThan(390);
	await image(page).click();
	let preview = page.getByRole("dialog", { name: "Image preview", exact: true });
	await expect(preview).toBeVisible();
	expect(
		await preview.getByRole("img").evaluate(element => {
			let box = element.getBoundingClientRect();
			return box.x >= 0 && box.right <= innerWidth;
		}),
	).toBe(true);
	await page.keyboard.press("Escape");
});

test("large saved images fit their column while neighboring text stays editable", async ({ join, page, room, seed }) => {
	await page.setViewportSize({ width: 1600, height: 900 });
	await loadImage(page);
	await seed(`<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">

<Image src="${IMAGE_URL}" alt="An open working document" width="1200" />

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

Neighboring notes.

</Column>
</Columns>
`);
	await join("ana");
	await page.getByRole("button", { name: "Hide chat", exact: true }).click();
	await expect.poll(() =>
		image(page).evaluate(element => {
			let column = element.closest(".planColumn")!;
			return element.getBoundingClientRect().width <= column.getBoundingClientRect().width;
		})
	).toBe(true);
	await image(page).hover();
	let corner = content(page).getByRole("slider", {
		name: "Resize image from bottom right",
		exact: true,
	});
	await corner.focus();
	let resized = Math.round(await width(page)) - 10;
	await corner.press("ArrowLeft");
	await expect.poll(() => width(page)).toBeCloseTo(resized, 0);
	await written(page, room, new RegExp(`width="${resized}"`));
	await content(page).getByText("Neighboring notes.", { exact: true }).selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type(" Still editable.");
	await written(page, room, /Neighboring notes\. Still editable\./);
});

test("disconnect removes editing controls while keeping image inspection available", async ({ join, page, seed }) => {
	let sockets: WebSocketRoute[] = [];
	let offline = false;
	await page.routeWebSocket("**/ws?**", route => {
		if (offline) return route.close();
		route.connectToServer();
		sockets.push(route);
	});
	await loadImage(page);
	await seed(SOURCE);
	await join("ana");
	offline = true;
	await sockets.at(-1)!.close();
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await image(page).hover();
	await expect(content(page).getByRole("button", { name: "Edit image", exact: true })).toHaveCount(
		0,
	);
	await image(page).click();
	await expect(page.getByRole("dialog", { name: "Image preview", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
});
