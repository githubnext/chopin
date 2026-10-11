import { content, expect, test } from "./room";
import { deckSeed } from "./decision-deck-fixtures";

import type { Page } from "@playwright/test";

function deck(page: Page) {
	return page.locator('[data-document-view="plan"] [data-deck]');
}

function top(page: Page) {
	return deck(page).locator("[data-deck-top]");
}

test("adjacent decisions in a document form one deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await expect(deck(page)).toHaveCount(1);
	await expect(deck(page)).toHaveAttribute("aria-roledescription", "carousel");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(deck(page).locator("[data-deck-slot]:not([data-deck-top])")).toHaveCount(2);
	for (let slot of await deck(page).locator("[data-deck-slot]:not([data-deck-top])").all()) {
		await expect(slot).toHaveAttribute("inert", "");
	}
	await expect(deck(page).getByText("1 of 3")).toBeVisible();

	// Followers and the caret paragraphs before them take no room of their own.
	let followers = content(page).locator("[data-plan-questionnaire]:has(> [data-deck-follower])");
	await expect(followers).toHaveCount(2);
	for (let follower of await followers.all()) await expect(follower).toBeHidden();
	let deckBox = (await deck(page).boundingBox())!;
	let trailing = (await content(page).getByText("Trailing paragraph.").boundingBox())!;
	let lineHeight = await content(page).evaluate(element =>
		Number.parseFloat(getComputedStyle(element).lineHeight)
	);
	expect(trailing.y - (deckBox.y + deckBox.height)).toBeLessThanOrEqual(lineHeight * 1.5);
});

test("decisions separated by prose stay separate cards", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2, { separated: true });
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await expect(page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]'))
		.toHaveCount(2);
	await expect(deck(page)).toHaveCount(0);
});

test("next, previous and arrow keys cycle without moving the caret", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph.", after: "Trailing paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await content(page).getByText("Trailing paragraph.").click();
	let caret = await page.evaluate(() => {
		let selection = getSelection()!;
		return [selection.anchorNode?.textContent, selection.anchorOffset];
	});

	let next = deck(page).getByRole("button", { name: "Next decision" });
	await next.click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByRole("status")).toHaveText("Decision 2 of 3: Scope");

	await next.focus();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[2] })).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await expect(next).toBeFocused();

	await content(page).getByText("Trailing paragraph.").click();
	expect(
		await page.evaluate(() => {
			let selection = getSelection()!;
			return [selection.anchorNode?.textContent, selection.anchorOffset];
		}),
	).toEqual(caret);
	await expect(content(page)).toContainText("Intro paragraph.");
});

test("arrow keys inside a card's options do not cycle the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await top(page).getByText("Option 1", { exact: true }).click();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
});

test("the deck keeps its top card, focus and draft when its first card leaves", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let ana = await join("ana");
	let ben = await join("ben");

	await deck(ana).getByRole("button", { name: "Next decision" }).click();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await top(ana).getByRole("button", { name: "Add an option", exact: true }).click();
	let draft = top(ana).getByRole("textbox", { name: "New option" });
	await draft.fill("Keep it in Yjs");
	await expect(draft).toBeFocused();

	let first = top(ben);
	await expect(first.getByRole("heading", { name: fixture.prompts[0] })).toBeVisible();
	await first.getByRole("button", { name: "Discard", exact: true }).click();
	await first.getByRole("button", { name: "Discard", exact: true }).click();

	await expect(deck(ana).getByText("1 of 2")).toBeVisible();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(draft).toHaveValue("Keep it in Yjs");
	await expect(draft).toBeFocused();
});

test("answering the last open card hands focus to its settled line", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");

	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByText("1 of 2 · 1 decided")).toBeVisible();

	await top(page).getByText("Option 2", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(deck(page)).toHaveCount(0);
	let settled = content(page).locator(
		`[data-plan-questionnaire="${fixture.ids[1]}"] [data-card-settled]`,
	);
	await expect(settled).toBeFocused();
});

test("an answered decision settles to the back and focus follows the new top", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await top(page).getByText("Option 1", { exact: true }).click();
	await top(page).getByRole("button", { name: "Save", exact: true }).click();

	await expect(top(page).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
	await expect(deck(page).getByText("1 decided")).toBeVisible();
	await expect(deck(page).getByRole("status"))
		.toHaveText("Decided. Now showing 1 of 3: Scope");
	await expect(top(page)).toBeFocused();
});

test("a collaborator's answer reorders without moving my top card", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let ana = await join("ana");
	let ben = await join("ben");
	await deck(ana).getByRole("button", { name: "Next decision" }).click();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();

	await top(ben).getByText("Option 1", { exact: true }).click();
	await top(ben).getByRole("button", { name: "Save", exact: true }).click();

	await expect(deck(ana).getByText("1 decided")).toBeVisible();
	await expect(top(ana).getByRole("heading", { name: fixture.prompts[1] })).toBeVisible();
});

test("answering every decision dissolves the deck", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 2);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	for (let index = 0; index < 2; index++) {
		await top(page).getByText(`Option ${index + 1}`, { exact: true }).click();
		await top(page).getByRole("button", { name: "Save", exact: true }).click();
	}
	await expect(deck(page)).toHaveCount(0);
	await expect(page.locator('[data-document-view="plan"] [data-card-settled]')).toHaveCount(2);
});

test("revealing a back card brings it to the top", async ({ join, seed }) => {
	let fixture = deckSeed({ before: "Intro paragraph." }, 3);
	await seed(fixture.source, fixture.state);
	let page = await join("ana");
	await page.locator(`[data-deck-slot="${fixture.ids[2]}"]`).evaluate(element =>
		element.dispatchEvent(
			new CustomEvent("chopin:deck-front", {
				bubbles: true,
				detail: (element as HTMLElement).dataset.deckSlot,
			}),
		)
	);
	await expect(top(page).getByRole("heading", { name: fixture.prompts[2] })).toBeVisible();
});
