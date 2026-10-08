import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readSource } from "./database";
import { authenticate, content, expect, roomPath, test, written } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

let directory = new URL("../experiments/openui-composition-trial/", import.meta.url);
let gallery = readFileSync(new URL("document-gallery-first.md", directory), "utf8");
let comparison = readFileSync(new URL("source-comparison-first.openui", directory), "utf8").trim();
let original = readFileSync(new URL("source-gallery-first.openui", directory), "utf8").trim();
let imageDirectory = fileURLToPath(
	new URL("./test-results/openui-composition-trial/", import.meta.url),
);

function section(page: import("@playwright/test").Page) {
	return content(page).getByRole("region", { name: "Excel header styling choices" });
}

test("composition renders gallery, table and detail with private filter in wide and narrow documents", async ({ join, seed }) => {
	await seed(gallery);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let view = section(page);
	await expect(view).toBeVisible();
	await expect(view.getByRole("article")).toHaveCount(3);
	await expect(view.getByRole("region", { name: "Comparison table" }).getByRole("row"))
		.toHaveCount(4);
	await expect(view.getByRole("img", { name: /Illustrative spreadsheet/ })).toHaveCount(3);
	let filter = view.getByRole("combobox", { name: "Show options" });
	await filter.selectOption("plain");
	await expect(view.getByRole("article")).toHaveCount(1);
	await filter.selectOption("all");
	let detail = view.getByText("Style with Styler", { exact: true }).last();
	await detail.focus();
	await detail.press("Enter");
	await expect(view.getByText("The proposal suggests documenting", { exact: false })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	mkdirSync(imageDirectory, { recursive: true });
	await page.screenshot({ path: `${imageDirectory}/live-wide.png` });

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(view.getByRole("combobox", { name: "Show options" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: `${imageDirectory}/live-narrow.png` });
});

test("authored arrangement persists on reopen while reader controls stay private", async ({ baseURL, browser, join, room, seed }) => {
	await seed(gallery);
	let writer = await join("ana");
	let view = section(writer);
	await expect(view).toBeVisible();
	let port = Number(new URL(writer.url()).port);
	let authored = await readSource(port, room);
	await view.getByRole("combobox", { name: "Show options" }).selectOption("plain");
	await writer.reload();
	expect(await readSource(port, room)).toBe(authored);
	await expect(section(writer).getByRole("article")).toHaveCount(3);

	await content(writer).getByRole("button", { name: "Show source" }).click();
	let source = content(writer).locator("[data-plan-source]");
	await source.selectText();
	await writer.keyboard.insertText(comparison);
	await written(writer, room, /\[comparison, gallery, details\]/);
	await writer.reload();
	await expect(section(writer).getByRole("heading", { name: "Start with tradeoffs" }))
		.toBeVisible();
	await expect(section(writer).locator(".openui-options-gallery"))
		.toHaveAttribute("data-layout", "rail");

	let conclusion = content(writer).getByText("The proposed plain default", { exact: false });
	await conclusion.selectText();
	await writer.keyboard.press("ArrowRight");
	await writer.keyboard.type(" Reader note.");
	await written(writer, room, /do not alter this document\. Reader note\./);

	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await section(reader).getByRole("combobox", { name: "Show options" }).selectOption("styled");
		await expect(section(reader).getByRole("article")).toHaveCount(1);
		await expect(section(writer).getByRole("article")).toHaveCount(3);
		await reader.reload();
		await expect(section(reader).getByRole("article")).toHaveCount(3);
	} finally {
		await context.close();
	}
});

test("invalid source is contained and can be repaired without losing adjacent prose", async ({ join, room, seed }) => {
	await seed(gallery);
	let page = await join("ana");
	await expect(section(page)).toBeVisible();
	await content(page).getByRole("button", { name: "Show source" }).click();
	let source = content(page).locator("[data-plan-source]");
	await source.selectText();
	await page.keyboard.insertText("root = UnknownComponent()");
	await written(page, room, /root = UnknownComponent\(\)/);
	await expect(content(page).locator("[data-plan-error]")).toBeVisible();
	await expect(content(page).getByText("The pandas development source asks", { exact: false }))
		.toBeVisible();
	await source.selectText();
	await page.keyboard.insertText(original);
	await written(page, room, /\[gallery, comparison, details\]/);
	await expect(section(page).getByRole("article")).toHaveCount(3);
});
