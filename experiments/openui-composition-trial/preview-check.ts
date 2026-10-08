import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

let base = process.env.OPENUI_TRIAL_URL ?? "http://127.0.0.1:5186/openui-composition-trial";
let output = fileURLToPath(
	new URL("../../e2e/test-results/openui-composition-trial/", import.meta.url),
);
mkdirSync(output, { recursive: true });

async function capture(page: import("@playwright/test").Page, name: string) {
	let height = await page.locator(".openui-trial-page").evaluate(element => element.scrollHeight);
	await page.setViewportSize({ width: page.viewportSize()!.width, height: Math.ceil(height) });
	await page.evaluate(() => scrollTo(0, 0));
	await page.screenshot({ path: `${output}/${name}.png` });
}

let browser = await chromium.launch({ headless: true });
try {
	let page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.on("pageerror", error => console.error("page error", error.message));
	await page.goto(base);
	let section = page.getByRole("region", { name: "Excel header styling choices" });
	await expect(section).toBeVisible();
	await expect(section.getByRole("article")).toHaveCount(3);
	await expect(section.getByRole("table")).toHaveCount(1);
	await capture(page, "gallery-wide");

	await section.getByRole("combobox", { name: "Show options" }).selectOption("plain");
	await expect(section.getByRole("article")).toHaveCount(1);
	await expect(section.getByRole("region", { name: "Comparison table" }).getByRole("row"))
		.toHaveCount(2);
	await section.getByRole("combobox", { name: "Show options" }).selectOption("all");
	let detail = section.getByText("Style with Styler", { exact: true }).last();
	await detail.click();
	await expect(section.getByText("The proposal suggests documenting", { exact: false }))
		.toBeVisible();

	await page.getByRole("button", { name: "Comparison first" }).click();
	await expect(section.getByRole("heading", { name: "Start with tradeoffs" })).toBeVisible();
	await expect(section.locator(".openui-options-gallery")).toHaveAttribute("data-layout", "rail");
	await capture(page, "comparison-wide");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await page.getByRole("button", { name: "Comparison first" }).click();
	await expect(section.getByRole("heading", { name: "Read the source reasoning" })).toBeVisible();
	await capture(page, "comparison-narrow");
	let overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
	if (overflow) throw new Error("Narrow page has horizontal overflow");

	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Ordinary document" }).click();
	await expect(page.getByRole("heading", { name: "Keep current default" })).toBeVisible();
	await capture(page, "ordinary-narrow");
	console.log(`Preview checks passed. Screenshots: ${output}`);
} finally {
	await browser.close();
}
