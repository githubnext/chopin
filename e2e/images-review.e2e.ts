import { readFileSync } from "node:fs";

import { content, expect, ready, test, written } from "./room";

const IMAGE_URL = "https://example.com/image-review.svg";
const IMAGE = readFileSync(new URL("./fixtures/gallery-document.svg", import.meta.url));

test("bold formatting preserves the H4 heading weight", async ({ join, page, seed }, testInfo) => {
	await seed("#### A heading with **bold words**\n\nA paragraph with **bold words**.\n");
	await join("ana");
	let heading = content(page).getByRole("heading", { level: 4 });
	await content(page).screenshot({ path: testInfo.outputPath("h4-bold-formatting.png") });
	await expect(heading).toHaveCSS("font-weight", "700");
	await expect(heading.getByText("bold words", { exact: true })).toHaveCSS("font-weight", "700");
});

test("image control keyboard input does not edit surrounding prose", async ({ join, page, room, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.route(
		IMAGE_URL,
		route => route.fulfill({ contentType: "image/svg+xml", body: IMAGE }),
	);
	await seed(`<Image src="${IMAGE_URL}" alt="Review image" width="320" />\n\nKeep this text.\n`);
	await join("ana");
	let picture = content(page).getByRole("img", { name: "Review image", exact: true });
	await picture.hover();
	let reset = content(page).getByRole("button", { name: "Reset image size", exact: true });
	await reset.focus();
	await reset.press("Enter");
	await written(page, room, `![Review image](${IMAGE_URL})`);
	let corner = content(page).getByRole("slider", {
		name: "Resize image from bottom right",
		exact: true,
	});
	await corner.focus();
	await corner.press("ArrowLeft");
	await written(page, room, /width="470"/);
	await reset.focus();
	await reset.press("Space");
	await written(page, room, `![Review image](${IMAGE_URL})`);
	await corner.focus();
	let paragraphs = await content(page).locator("p").count();
	await corner.press("Enter");
	await expect(content(page).locator("p")).toHaveCount(paragraphs);
	await corner.press("Backspace");
	await expect(picture).toBeVisible();
	await expect(content(page).getByText("Keep this text.", { exact: true })).toBeVisible();
});

test("resizing table images preserves pipes and entity text through reload", async ({ join, page, room, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.route(
		IMAGE_URL,
		route => route.fulfill({ contentType: "image/svg+xml", body: IMAGE }),
	);
	await seed(`| Prototype |\n| --- |\n| ![Prototype \\| &amp;amp; details](${IMAGE_URL}) |\n`);
	await join("ana");
	let picture = content(page).getByRole("img", { name: "Prototype | &amp; details", exact: true });
	await picture.hover();
	let initial = await picture.evaluate(element => element.getBoundingClientRect().width);
	let corner = content(page).getByRole("slider", {
		name: "Resize image from bottom right",
		exact: true,
	});
	await corner.focus();
	await corner.press("ArrowLeft");
	await written(page, room, new RegExp(`width="${Math.round(initial - 10)}"`));
	await expect(picture).toBeVisible();
	await page.reload();
	await ready(page);
	await expect(picture).toBeVisible();
});
