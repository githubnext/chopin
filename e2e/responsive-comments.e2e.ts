import { content, expect, test } from "./room";

const TARGET = "Paragraph 30 contains enough text to receive a comment.";
const PLAN = Array.from(
	{ length: 40 },
	(_, index) => `Paragraph ${index + 1} contains enough text to receive a comment.`,
).join("\n\n");

test("a representative compact viewport keeps a passage above the sheet and restores the document", async ({ join, seed }) => {
	let viewport = { width: 390, height: 844 };
	await seed(PLAN);
	let page = await join("ana", { hasTouch: true, viewport });
	let scroller = page.locator("[data-plan-scroll]");
	let passage = content(page).getByText(TARGET, { exact: true });
	await expect(page.getByRole("navigation", { name: "Workspace view" })).toBeVisible();
	await expect(page.locator("[data-plan-comment-sheet]")).toHaveCount(1);

	await passage.scrollIntoViewIfNeeded();
	await passage.selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this paragraph close.");
	await draft.getByRole("button", { name: "Comment" }).click();
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
	await expect.poll(async () => {
		let sheetBox = await sheet.boundingBox();
		let passageBox = await passage.boundingBox();
		return sheetBox!.y >= passageBox!.y + passageBox!.height;
	}).toBe(true);
	await sheet.getByRole("button", { name: "Close comment" }).click();
	let closing = page.locator(".motion-comment-surface.is-closing");
	await expect(closing).toHaveAttribute("aria-hidden", "true");
	await expect(closing).toHaveAttribute("inert", "");
	await expect(closing).toHaveCount(0);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(
		originalScroll,
		0,
	);
});
