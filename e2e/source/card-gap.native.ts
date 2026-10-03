import { expect, test } from "@playwright/test";
import {
	active,
	assertCardGapErrors,
	compacted,
	loadCardGap,
	paintGap,
	prepareCardGap,
} from "./card-gap-native";
test.beforeAll(prepareCardGap);
test.afterEach(async ({ page }) => {
	await assertCardGapErrors(page);
});

for (let gate of ["canEdit", "connected", "synced"] as const) {
	test(`actual ${gate}=false retains canonical card gaps until the real gate enables`, async ({ page }) => {
		await loadCardGap(page, { ...active, [gate]: false });
		await paintGap(page);
		let before = await page.evaluate(() => window.cardGapFixture.snapshot());
		expect(before.keys).toEqual(before.initial);
		expect(before.keys).toHaveLength(13);
		expect(before.yjs.xml).toBe(before.yjs.roundtrip);
		expect(before.yjs.blocks).toEqual(before.yjs.restoredBlocks);
		expect(before.yjs.blocks.map(block => block.type)).toEqual(before.types);
		expect(before.yjs.blocks.filter(block => block.type === "paragraph")).toHaveLength(9);
		await expect(page.getByRole("textbox", { name: "Gap document", exact: true })).toHaveAttribute(
			"contenteditable",
			String(gate !== "canEdit"),
		);
		await page.evaluate(flags => window.cardGapFixture.flags(flags), active);
		let after = await compacted(page);
		expect(after.expected).toEqual(before.expected);
		expect(after.yjs.update).not.toEqual(before.yjs.update);
		expect(after.yjs.blocks.filter(block => block.type !== "paragraph")).toEqual(
			before.yjs.blocks.filter(block => block.type !== "paragraph"),
		);
	});
}

test("actual collapsed caret protects its run while other mixed-card gaps compact", async ({ page }) => {
	await loadCardGap(page, active, "caret");
	await paintGap(page);
	let before = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(before.keys).toEqual(before.initial.filter((_, index) => index !== 9));
	expect(before.selection).toEqual({ collapsed: true, key: before.initial[3] });
	await page.getByRole("textbox", { name: "Gap document", exact: true }).getByText(
		"Keep this exact prose.",
		{ exact: true },
	).click();
	await compacted(page);
});

test("actual noncollapsed range defers every gap until native selection changes", async ({ page }) => {
	await loadCardGap(page, active, "range");
	await paintGap(page);
	let before = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(before.keys).toEqual(before.initial);
	expect(before.selection?.collapsed).toBe(false);
	await page.getByRole("textbox", { name: "Gap document", exact: true }).getByText(
		"Keep this exact prose.",
		{ exact: true },
	).click();
	await compacted(page);
});

test("disconnect retires the old deferred selection subscription and reconnect compacts real state", async ({ page }) => {
	await loadCardGap(page, active, "caret");
	await paintGap(page);
	let before = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(before.keys).toHaveLength(12);
	await page.evaluate(flags => window.cardGapFixture.flags({ ...flags, connected: false }), active);
	await paintGap(page);
	await page.getByRole("textbox", { name: "Gap document", exact: true }).getByText(
		"Keep this exact prose.",
		{ exact: true },
	).click();
	await paintGap(page);
	expect((await page.evaluate(() => window.cardGapFixture.snapshot())).keys).toEqual(before.keys);
	await page.evaluate(() => window.cardGapFixture.seed());
	await paintGap(page);
	let seeded = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(seeded.keys).toEqual(seeded.initial);
	await page.evaluate(flags => window.cardGapFixture.flags(flags), active);
	await compacted(page);
});

test("unmount retires actual transforms and deferred command before plugin remount", async ({ page }) => {
	await loadCardGap(page, active, "caret");
	await paintGap(page);
	let before = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(before.keys).toHaveLength(12);
	await page.evaluate(() => window.cardGapFixture.plugin(false));
	await expect(page.locator("[data-gap-plugin-mounted]")).toHaveAttribute(
		"data-gap-plugin-mounted",
		"false",
	);
	await paintGap(page);
	await page.getByRole("textbox", { name: "Gap document", exact: true }).getByText(
		"Keep this exact prose.",
		{ exact: true },
	).click();
	await paintGap(page);
	expect((await page.evaluate(() => window.cardGapFixture.snapshot())).keys).toEqual(before.keys);
	await page.evaluate(() => window.cardGapFixture.seed());
	await paintGap(page);
	let seeded = await page.evaluate(() => window.cardGapFixture.snapshot());
	expect(seeded.keys).toEqual(seeded.initial);
	await page.evaluate(() => window.cardGapFixture.plugin(true));
	await compacted(page);
});
