import { expect, test } from "./room";

const PROSE = "Room state lives on disk as MDX beside the transcript.\n";

test("a Planner question without a conversation thread has no evidence popover", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.first();
	await expect(card).toBeVisible();
	await card.hover();
	await page.waitForTimeout(600);
	await expect(page.getByRole("dialog", { name: /^Evidence for/ })).toHaveCount(0);
});
