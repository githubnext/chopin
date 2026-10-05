import { expect, test } from "./room";

const TARGET = "Paragraph 30 contains enough text to receive a comment.";
const PLAN = Array.from(
	{ length: 40 },
	(_, index) => `Paragraph ${index + 1} contains enough text to receive a comment.`,
).join("\n\n");

test("320×568 uses the compact comment drawer", async ({ join, seed }) => {
	let viewport = { width: 320, height: 568 };
	await seed(PLAN);
	let page = await join("ana", { hasTouch: true, viewport });
	await page.getByRole("button", { name: /Comment on “/ }).first().tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await expect(sheet.getByRole("button", { name: "Resize comment sheet" })).toBeFocused();
	await expect.poll(async () => (await sheet.boundingBox())!.y / viewport.height).toBeLessThan(0.5);
	let box = await sheet.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.y / viewport.height).toBeGreaterThan(0.4);
	expect(box!.x).toBe(0);
	expect(box!.width).toBe(viewport.width);
	await expect(sheet.getByRole("button", { name: "Close comment" })).toHaveClass(/sr-only/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		viewport.width,
	);

	await page.setViewportSize({ width: 768, height: 1_024 });
	let popover = page.getByRole("dialog", { name: "Comment thread" });
	await expect(popover).not.toHaveAttribute("aria-modal", "true");
	await expect(page.getByRole("button", { name: "Resize comment sheet" })).toHaveCount(0);
	await expect(popover.getByRole("button", { name: "Close comment" })).toBeFocused();
});

test("768×1024 keeps comments in a document popover", async ({ join, seed }) => {
	await seed(PLAN);
	let page = await join("ana", { hasTouch: true, viewport: { width: 768, height: 1_024 } });
	await page.getByRole("button", { name: /Comment on “/ }).first().tap();
	let popover = page.getByRole("dialog", { name: "Comment thread" });
	await expect(popover).toBeVisible();
	await expect(popover).not.toHaveAttribute("aria-modal", "true");
	await expect(page.getByRole("button", { name: "Resize comment sheet" })).toHaveCount(0);
});

test("a representative compact viewport keeps a passage above the sheet and restores the document", async ({ join, seed }) => {
	let viewport = { width: 390, height: 844 };
	await seed(PLAN);
	let page = await join("ana", { hasTouch: true, viewport });
	let scroller = page.locator("[data-plan-scroll]");
	let passage = page.locator(".plan-content > p").filter({ hasText: TARGET });
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();

	await passage.scrollIntoViewIfNeeded();
	await passage.selectText();
	let commentAction = page.getByRole("button", {
		name: "Comment on this passage",
		exact: true,
	});
	let actionBox = await commentAction.boundingBox();
	let iconBox = await commentAction.locator("[data-nucleo-icon]").boundingBox();
	expect(actionBox).not.toBeNull();
	expect(iconBox).not.toBeNull();
	expect(Math.abs(
		actionBox!.x + actionBox!.width / 2 - (iconBox!.x + iconBox!.width / 2),
	)).toBeLessThanOrEqual(1);
	expect(Math.abs(
		actionBox!.y + actionBox!.height / 2 - (iconBox!.y + iconBox!.height / 2),
	)).toBeLessThanOrEqual(1);
	let entryFrames = page.evaluate(async () => {
		let frames: number[] = [];
		for (let index = 0; index < 36; index++) {
			await new Promise(requestAnimationFrame);
			let sheet = document.querySelector("[data-plan-comment-sheet]");
			if (sheet) frames.push(sheet.getBoundingClientRect().y);
		}
		return frames;
	});
	await commentAction.click();
	let frames = await entryFrames;
	expect(frames.length).toBeGreaterThan(2);
	expect(frames[0]).toBeGreaterThan(viewport.height * 0.75);
	expect(frames.at(-1)).toBeLessThan(frames[0]!);
	let draft = page.getByRole("dialog", { name: "New comment" });
	await expect.poll(async () => {
		let sheetBox = await draft.boundingBox();
		let passageBox = await passage.boundingBox();
		return sheetBox!.y >= passageBox!.y + passageBox!.height;
	}).toBe(true);
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this paragraph close.");
	await draft.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(draft).toHaveCount(0);

	await passage.evaluate(element => {
		let scroller = element.closest("[data-plan-scroll]")!;
		let passage = element.getBoundingClientRect();
		let viewport = scroller.getBoundingClientRect();
		scroller.scrollTop += passage.bottom - viewport.bottom + 64;
		scroller.dispatchEvent(new Event("scroll"));
	});
	// Let the document host persist the reader's position before the sheet
	// changes layout; the controlled scroll value is restored on re-render.
	await page.evaluate(() =>
		new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	let originalScroll = await scroller.evaluate(element => element.scrollTop);
	let marker = page.getByRole("button", {
		name: /Comment on “Paragraph 30 contains enough text/,
	});
	await expect(marker).toBeInViewport();
	let markerBox = await marker.boundingBox();
	await page.touchscreen.tap(
		markerBox!.x + markerBox!.width / 2,
		markerBox!.y + markerBox!.height / 2,
	);

	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await expect(sheet).toHaveAttribute("aria-modal", "true");
	let grabber = sheet.getByRole("button", { name: "Resize comment sheet" });
	await expect(grabber).toBeFocused();
	let accessibleClose = sheet.getByRole("button", { name: "Close comment" });
	await expect(accessibleClose).toHaveClass(/sr-only/);
	await expect(accessibleClose.locator("svg")).toHaveCount(0);
	await expect(page.locator("[data-plan-comment-sheet-backdrop]")).toBeVisible();

	let drawerStyles = await sheet.evaluate(element => {
		let styles = getComputedStyle(element);
		return {
			offset: styles.getPropertyValue("--drawer-snap-point-offset"),
			transform: styles.transform,
		};
	});
	expect(drawerStyles.offset).not.toBe("");
	expect(drawerStyles.transform).not.toBe("none");

	await expect.poll(async () => (await sheet.boundingBox())!.y).toBeLessThan(
		viewport.height * 0.5,
	);
	let medium = await sheet.boundingBox();
	expect(medium).not.toBeNull();
	expect(medium!.y).toBeGreaterThan(viewport.height * 0.4);

	let navigation = page.getByRole("navigation", {
		name: "Workspace view",
		includeHidden: true,
	});
	let navBox = await navigation.boundingBox();
	expect(navBox).not.toBeNull();
	expect(
		await page.evaluate(({ x, y }) => {
			return !!document.elementFromPoint(x, y)?.closest("[data-plan-comment-sheet-backdrop]");
		}, {
			x: navBox!.x + navBox!.width / 2,
			y: navBox!.y + navBox!.height / 2,
		}),
	).toBe(true);
	await expect.poll(async () => {
		let sheetBox = await sheet.boundingBox();
		let passageBox = await passage.boundingBox();
		return sheetBox!.y >= passageBox!.y + passageBox!.height;
	}).toBe(true);
	let grabberBox = await grabber.boundingBox();
	expect(grabberBox).not.toBeNull();
	let touch = await page.context().newCDPSession(page);
	let x = grabberBox!.x + grabberBox!.width / 2;
	let y = grabberBox!.y + grabberBox!.height / 2;
	await touch.send("Input.dispatchTouchEvent", {
		touchPoints: [{ x, y }],
		type: "touchStart",
	});
	for (let step = 1; step <= 12; step++) {
		await touch.send("Input.dispatchTouchEvent", {
			touchPoints: [{ x, y: y + (64 - y) * step / 12 }],
			type: "touchMove",
		});
	}
	await touch.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
	await expect.poll(async () => (await sheet.boundingBox())!.y).toBeLessThan(
		viewport.height * 0.12,
	);
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(
		originalScroll,
		0,
	);
});

for (
	let [name, viewport, hasTouch] of [
		["desktop", { width: 1_440, height: 900 }, false],
		["phone", { width: 390, height: 844 }, true],
	] as const
) {
	test(`${name} comment marker scrolls away with its passage`, async ({ join, seed }) => {
		await seed(PLAN);
		let page = await join("ana", { hasTouch, viewport });
		let scroller = page.locator("[data-plan-scroll]");
		let marker = page.locator("[data-plan-comment-button]").first();
		await expect(marker).toBeVisible();
		let resting = (await marker.boundingBox())!;

		await scroller.evaluate(element => element.scrollBy(0, 1_500));
		await expect(marker).toBeHidden();
		let frame = (await scroller.boundingBox())!;
		await expect.poll(async () => (await marker.boundingBox())!.y).toBeLessThan(frame.y);

		await scroller.evaluate(element => element.scrollTo(0, 0));
		await expect(marker).toBeVisible();
		await expect.poll(async () => (await marker.boundingBox())!.y).toBe(resting.y);
	});
}

test("an open comment keeps its marker and focus after its passage scrolls away", async ({ join, seed }) => {
	await seed(PLAN);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	let scroller = page.locator("[data-plan-scroll]");
	let marker = page.locator("[data-plan-comment-button]").first();
	await marker.click();
	let card = page.getByRole("dialog", { name: "Comment thread" });
	await expect(card).toBeVisible();

	await scroller.evaluate(element => element.scrollBy(0, 1_500));
	await expect(marker).toBeVisible();
	await expect(card).toBeVisible();
	let frame = (await scroller.boundingBox())!;
	expect((await marker.boundingBox())!.y).toBeGreaterThanOrEqual(frame.y - 1);
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

const GROUP = /^2 comments on “Paragraph 1 contains enough text/;

async function commentOn(page: import("@playwright/test").Page, index: number, text: string) {
	await page.locator(".plan-content > p").nth(index).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill(text);
	await draft.getByRole("button", { name: /^(Comment|Post comment)$/ }).click();
	await expect(draft).toHaveCount(0);
	await page.keyboard.press("Escape");
}

for (
	let [name, viewport, hasTouch] of [
		["desktop", { width: 1_440, height: 900 }, false],
		["phone", { width: 390, height: 844 }, true],
	] as const
) {
	test(`${name} threads on one block share one marker beside its first line`, async ({ join, seed }) => {
		await seed(PLAN);
		let page = await join("ana", { hasTouch, viewport });
		await expect(page.locator("[data-plan-comment-button]")).toHaveCount(1);
		await commentOn(page, 0, "A second thought on the same paragraph.");

		let marker = page.getByRole("button", { name: GROUP });
		await expect(marker).toBeVisible();
		await expect(page.locator("[data-plan-comment-button]")).toHaveCount(1);
		await expect(marker.locator(".plan-comment-count")).toHaveText("2");

		// The visible chip sits beside the block, never over its text.
		let chip = (await marker.locator(".plan-comment-chip").boundingBox())!;
		let paragraph = (await page.locator(".plan-content > p").first().boundingBox())!;
		let documentBox = (await page.locator(".plan-document").boundingBox())!;
		expect(chip.x).toBeGreaterThanOrEqual(paragraph.x + paragraph.width);
		expect(chip.x + chip.width).toBeLessThanOrEqual(documentBox.x + documentBox.width);
		expect(chip.y).toBeLessThan(paragraph.y + 32);
		expect(chip.height).toBe(24);
		if (hasTouch) expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	});
}

test("a grouped marker opens a list of its threads and keeps keyboard order", async ({ join, seed }) => {
	await seed(PLAN);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	await commentOn(page, 0, "A second thought on the same paragraph.");
	let marker = page.getByRole("button", { name: GROUP });

	await marker.focus();
	await page.keyboard.press("Enter");
	let list = page.getByRole("dialog", { name: "Comments" });
	await expect(list).toBeVisible();
	let items = list.locator("[data-plan-comment-group-item]");
	await expect(items).toHaveCount(2);
	await expect(items.first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(items.nth(1)).toBeFocused();
	await expect(items.nth(1)).toContainText("A second thought on the same paragraph.");

	await page.keyboard.press("Enter");
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread).toContainText("A second thought on the same paragraph.");
	let back = thread.getByRole("button", { name: "All 2 comments" });
	await expect(back).toBeFocused();
	await back.click();
	await expect(list).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(marker).toBeFocused();
});

test("an open comment card renders above every other marker", async ({ join, seed }) => {
	await seed(PLAN);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	for (let index = 1; index <= 4; index++) await commentOn(page, index, `Note ${index}.`);
	let markers = page.locator("[data-plan-comment-button]");
	await expect(markers).toHaveCount(5);

	await markers.first().click();
	let card = page.getByRole("dialog", { name: "Comment thread" });
	await expect(card).toBeVisible();
	await expect(page.locator("[data-plan-comment-button][data-dimmed]")).toHaveCount(4);
	await expect(page.locator("[data-plan-comment-button][inert]")).toHaveCount(4);

	let cardBox = (await card.boundingBox())!;
	let covered = await markers.evaluateAll((buttons, box) =>
		buttons.flatMap(button => {
			let chip = button.querySelector(".plan-comment-chip")!.getBoundingClientRect();
			let x = chip.left + chip.width / 2;
			let y = chip.top + chip.height / 2;
			let inside = x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
			return inside ? [!!document.elementFromPoint(x, y)?.closest("[role=dialog]")] : [];
		}), cardBox);
	expect(covered.length).toBeGreaterThan(0);
	expect(covered.every(Boolean)).toBe(true);
});
