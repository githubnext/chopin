import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readSource } from "./database";
import { authenticate, content, expect, roomPath, test, written } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator, Page } from "@playwright/test";

let fixtures = new URL("./fixtures/openui-composition/", import.meta.url);
let pandas = readFileSync(new URL("pandas-excel-styling.md", fixtures), "utf8");
let pagination = readFileSync(new URL("synthetic-pagination.md", fixtures), "utf8");
let pandasSource = pandas.match(/```openui-options\n([\s\S]*?)\n```/)?.[1];
if (!pandasSource) throw new Error("pandas composition fixture has no source fence");
let captureDirectory = new URL("./test-results/openui-composition/", import.meta.url);

function section(page: Page, title: string) {
	return content(page).getByRole("region", { name: title, exact: true });
}

async function capture(view: Locator, name: string) {
	if (process.env.OPENUI_CAPTURE !== "1") return;
	let page = view.page();
	let viewport = page.viewportSize();
	if (!viewport) throw new Error("OpenUI screenshot requires a fixed viewport");
	mkdirSync(captureDirectory, { recursive: true });
	try {
		await page.setViewportSize({ ...viewport, height: 2200 });
		await view.scrollIntoViewIfNeeded();
		let images = await view.locator("img").evaluateAll(async elements =>
			Promise.all(elements.map(async element => {
				let image = element as HTMLImageElement;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let state = await Promise.race([
					image.decode().then(() => "decoded" as const, () => "unavailable" as const),
					new Promise<"timeout">(resolve => {
						timer = setTimeout(() => resolve("timeout"), 10_000);
					}),
				]);
				if (timer) clearTimeout(timer);
				return { alt: image.alt, state, width: image.naturalWidth };
			}))
		);
		let failed = images.find(image => image.state !== "decoded" || image.width === 0);
		let fallback = await view.getByRole("img", { name: /^Image unavailable:/ }).count();
		if (failed || fallback) {
			let reason = failed
				? `Image ${failed.state} (${failed.width}px): ${failed.alt}`
				: `${fallback} image-unavailable fallback(s) shown`;
			let path = fileURLToPath(
				new URL(name.replace(/\.png$/, "-image-failure.png"), captureDirectory),
			);
			let saved = await view.screenshot({ path, animations: "disabled" }).then(
				() => path,
				() => undefined,
			);
			throw new Error(`OpenUI capture failed: ${reason}${saved ? `; diagnostic: ${saved}` : ""}`);
		}
		await view.screenshot({
			path: fileURLToPath(new URL(name, captureDirectory)),
			animations: "disabled",
		});
	} finally {
		await page.setViewportSize(viewport);
	}
}

test("the saved pandas document shows grounded media, a table and keyboard details", async ({ join, page, room, seed }) => {
	await seed(pandas);
	await page.setViewportSize({ width: 1440, height: 900 });
	let forbiddenRequests: string[] = [];
	page.on("request", request => {
		if (/cdn\.jsdelivr\.net|openui.*devtools|devtools.*openui/i.test(request.url())) {
			forbiddenRequests.push(request.url());
		}
	});
	await join("ana");
	let view = section(page, "Excel header styling");
	await expect(view).toBeVisible();
	expect(forbiddenRequests).toEqual([]);
	expect(await view.locator(":scope > section > h4").allTextContents()).toEqual([
		"Outputs",
		"Tradeoffs",
		"Source reasoning",
	]);
	await expect(view.getByRole("article")).toHaveCount(2);
	let firstCard = view.getByRole("article").first();
	let cardColumns = await firstCard.evaluate(card => {
		let media = card.querySelector("figure")!.getBoundingClientRect();
		let body = card.querySelector(".openui-options-card-body")!.getBoundingClientRect();
		return {
			beside: body.left >= media.right,
			aligned: Math.abs(body.top - media.top) < 2,
			roomy: body.width > media.width,
		};
	});
	expect(cardColumns).toEqual({ beside: true, aligned: true, roomy: true });
	await expect(view.getByRole("img", { name: /Spreadsheet with styled row and column headers/ }))
		.toBeVisible();
	await expect(view.locator("img")).toHaveAttribute("referrerpolicy", "no-referrer");
	await expect(view.getByText("Illustrative reconstruction; not a source screenshot"))
		.toBeVisible();
	await expect(view.getByRole("region", { name: "Comparison table" }).getByRole("row"))
		.toHaveCount(3);
	await capture(view, "pandas-wide.png");

	let disclosure = view.locator("details > summary").filter({ hasText: "Plain default" });
	await disclosure.focus();
	await disclosure.press("Enter");
	await expect(view.getByText("The issue proposes removing default header styling", {
		exact: false,
	})).toBeVisible();

	let authored = await readSource(Number(new URL(page.url()).port), room);
	let filter = view.getByRole("combobox", { name: "Show options" });
	await filter.selectOption({ label: "Current" });
	await expect(view.getByRole("article")).toHaveCount(1);
	await expect(view.getByRole("region", { name: "Comparison table" }).getByRole("row"))
		.toHaveCount(2);
	expect(await readSource(Number(new URL(page.url()).port), room)).toBe(authored);

	await page.reload();
	await expect(section(page, "Excel header styling").getByRole("article")).toHaveCount(2);
	await expect(
		section(page, "Excel header styling").getByRole("combobox", {
			name: "Show options",
		}),
	).toHaveValue("");
	await expect(
		section(page, "Excel header styling").getByText(
			"The issue proposes removing default header styling",
			{ exact: false },
		),
	).toBeHidden();

	await page.setViewportSize({ width: 390, height: 844 });
	let table = section(page, "Excel header styling").getByRole("region", {
		name: "Comparison table",
	});
	await expect(table).toBeVisible();
	await expect(section(page, "Excel header styling").getByText("Scroll to see more columns"))
		.toBeVisible();
	expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	await table.focus();
	await table.press("ArrowRight");
	await expect.poll(() => table.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
	await expectNoHorizontalOverflow(page);
	expect(forbiddenRequests).toEqual([]);
});

test("a saved comparison-first document has a rail and private filters for a read-only reader", async ({ baseURL, browser, join, room, seed }) => {
	await seed(pagination);
	let writer = await join("ana", { viewport: { width: 390, height: 844 } });
	let view = section(writer, "Pagination choices");
	await expect(view).toBeVisible();
	expect(await view.locator(":scope > section > h4").allTextContents()).toEqual([
		"Tradeoffs",
		"How each works",
		"Response shapes",
	]);
	let rail = view.getByRole("region", { name: "Response shapes gallery" });
	expect(await rail.getByRole("article").locator("h5").allTextContents()).toEqual([
		"Cursor",
		"Offset",
		"Keyset",
	]);
	await expect(view.getByRole("region", { name: "Comparison table" }).getByRole("row"))
		.toHaveCount(4);
	await expect(view.getByText("Synthetic request").first()).toBeVisible();
	await capture(view, "pagination-narrow.png");
	expect(await rail.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	await rail.focus();
	await rail.press("ArrowRight");
	await expect.poll(() => rail.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
	await expectNoHorizontalOverflow(writer);

	let authored = await readSource(Number(new URL(writer.url()).port), room);
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		let readerView = section(reader, "Pagination choices");
		await expect(readerView.getByRole("article")).toHaveCount(3);
		let readerFilter = readerView.getByRole("combobox", { name: "Show options" });
		await readerFilter.focus();
		await readerFilter.press("End");
		await expect(readerFilter).toHaveValue("Stable");
		await expect(readerView.getByRole("article")).toHaveCount(2);
		await expect(view.getByRole("article")).toHaveCount(3);
		await view.getByRole("combobox", { name: "Show options" })
			.selectOption({ label: "Simple" });
		await expect(view.getByRole("article")).toHaveCount(1);
		await expect(readerView.getByRole("article")).toHaveCount(2);
		expect(await readSource(Number(new URL(writer.url()).port), room)).toBe(authored);

		await Promise.all([writer.reload(), reader.reload()]);
		await expect(section(writer, "Pagination choices").getByRole("article")).toHaveCount(3);
		await expect(section(reader, "Pagination choices").getByRole("article")).toHaveCount(3);
		expect(await readSource(Number(new URL(writer.url()).port), room)).toBe(authored);
	} finally {
		await context.close();
	}
});

test("comparison and diagram previews survive a shared document reload", async ({ join, page, seed }) => {
	await seed(`${pandas}\n\n\`\`\`mermaid\ngraph LR;\nA-->B;\n\`\`\`\n`);
	await join("ana");
	await expect(section(page, "Excel header styling").getByRole("article")).toHaveCount(2);
	await expect(content(page).getByRole("region", { name: "Diagram preview" }).locator("svg"))
		.toBeVisible();
	await page.reload();
	await expect(section(page, "Excel header styling").getByRole("article")).toHaveCount(2);
	await expect(content(page).getByRole("region", { name: "Diagram preview" }).locator("svg"))
		.toBeVisible();
});

test("malformed source keeps adjacent prose and recovers after an authored repair", async ({ join, room, seed }) => {
	await seed(pandas);
	let page = await join("ana");
	await expect(section(page, "Excel header styling")).toBeVisible();
	await content(page).getByRole("button", { name: "Show source" }).click();
	let source = content(page).locator("[data-plan-source]");
	await source.selectText();
	await page.keyboard.insertText("root = UnknownComponent()");
	await written(page, room, /root = UnknownComponent\(\)/);
	await expect(content(page).locator("[data-plan-error]")).toBeVisible();
	await expect(
		content(page).getByText("The plain alternative is a proposal", {
			exact: false,
		}),
	).toBeVisible();
	await expect(source).toContainText("root = UnknownComponent()");

	await source.selectText();
	await page.keyboard.insertText(pandasSource);
	await written(page, room, /root = OptionsSection\("Excel header styling"/);
	await expect(section(page, "Excel header styling").getByRole("article")).toHaveCount(2);
	await expect(content(page).locator("[data-plan-error]")).toHaveCount(0);
	await page.reload();
	await expect(section(page, "Excel header styling").getByRole("article")).toHaveCount(2);
	await expect(
		content(page).getByText("The plain alternative is a proposal", {
			exact: false,
		}),
	).toBeVisible();
});
