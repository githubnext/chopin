import { expect, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

function questionnaire(page: import("@playwright/test").Page) {
	return page.getByRole("region", { name: "Decisions" })
		.locator("article[data-plan-sidecar-questionnaire]");
}

test("compact Decisions keeps its discarded group reachable", async ({ join, seed }) => {
	await seed("The compact decision workspace remains readable on a phone.\n");
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let decisions = page.getByRole("button", { name: /^Decisions/ });
	if (await decisions.getAttribute("aria-pressed") !== "true") await decisions.click();
	let card = questionnaire(page).filter({
		has: page.getByRole("heading", { name: "Where should room state live?" }),
	});
	await card.getByRole("button", { name: "Discard", exact: true }).click();
	await card.getByRole("button", { name: "Discard decision" }).click();

	let discarded = page.getByRole("button", { name: "1 discarded" });
	await expect(discarded).toHaveAttribute("aria-expanded", "false");
	await expectNoHorizontalOverflow(page);
	await discarded.scrollIntoViewIfNeeded();
	await expectInsideViewport(discarded);
	await discarded.click();
	await expect(
		page.locator('[data-document-view="decisions"] [data-decisions-group="discarded"]')
			.getByText("Discarded by @ana", { exact: true }),
	).toBeVisible();
	await expectNoHorizontalOverflow(page);
});
