/**
 * Planner questions reaching the Decisions tab, through the real server, sockets
 * and host tools, against the isolated `AGENT=on` fake-harness project.
 */
import { chatInput } from "./chat-input";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

async function ask(page: Page) {
	let input = chatInput(page);
	await input.fill("@chopin ASK-DECISIONS");
	await input.press("Enter");
}

function decisionsButton(page: Page) {
	return page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Decisions/ });
}

function deck(page: Page) {
	return page.locator('[data-document-view="decisions"] [data-deck]');
}

function top(page: Page) {
	return deck(page).locator("[data-deck-top]");
}

/** Answering ends the Planner's open ask, so the next @chopin message starts a new turn. */
async function answerAll(page: Page) {
	for (let index = 0; index < 3; index++) {
		await top(page).getByText("First option", { exact: true }).click();
		await top(page).getByRole("button", { name: "Save", exact: true }).click();
		if (index < 2) await expect(deck(page).getByText(`${index + 1} decided`)).toBeVisible();
	}
	await expect(deck(page)).toHaveCount(0);
}

function routed(page: Page) {
	return page.getByRole("status").filter({ hasText: "Showing Decisions:" });
}

test("a blank document routes the Planner's questions to a Decisions deck", async ({ join }) => {
	let page = await join("ana");
	await chatInput(page).click();
	await ask(page);

	await expect(decisionsButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect(routed(page).filter({ hasText: "Showing Decisions: 3 to answer" }))
		.toHaveCount(1);
	await expect(chatInput(page)).toBeFocused();
	await expect(deck(page)).toHaveAttribute("aria-label", "3 open decisions");
	await expect(deck(page).getByText("1 of 3")).toBeVisible();

	await answerAll(page);
	await expect(page.getByRole("button", { name: "3 resolved" })).toBeVisible();
	// No prose yet, so the forced view holds.
	await expect(decisionsButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("a reader editing the blank document is not moved", async ({ join }) => {
	let ana = await join("ana");
	let ben = await join("ben");
	await content(ana).click();
	await expect(content(ana)).toBeFocused();
	await ask(ben);

	await expect(decisionsButton(ben)).toHaveAttribute("aria-pressed", "true");
	await expect(decisionsButton(ana)).toContainText("3");
	await expect(decisionsButton(ana)).toHaveAttribute("aria-pressed", "false");
	await expect(content(ana)).toBeFocused();
	await expect(routed(ana)).toHaveCount(0);
});

test("an explicit tab pick keeps a blank document in Document when more decisions arrive", async ({ join }) => {
	let page = await join("ana");
	// The status region is one persistent element, so count announcements as they are inserted.
	await page.evaluate(() => {
		let seen = { count: 0 };
		(window as unknown as { routings: typeof seen }).routings = seen;
		new MutationObserver(records => {
			for (let record of records) {
				for (let node of record.addedNodes) {
					if (node.textContent?.includes("Showing Decisions:")) seen.count++;
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	let routings = () =>
		page.evaluate(() => (window as unknown as { routings: { count: number } }).routings.count);
	await ask(page);
	await expect(decisionsButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(routings).toBe(1);
	await answerAll(page);
	// The document stays blank: only the once-per-entry latch can stop a second route.
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await expect(decisionsButton(page)).toHaveAttribute("aria-pressed", "false");
	await chatInput(page).click();
	await ask(page);
	await expect(decisionsButton(page)).toContainText("3");
	await expect(decisionsButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await routings()).toBe(1);
});

test("arrow keys shuffle the Decisions deck; reduced motion reorders instantly", async ({ join }) => {
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await ask(page);
	await deck(page).getByRole("button", { name: "Next decision" }).focus();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: "What belongs in the first cut?" }))
		.toBeVisible();
	expect(await deck(page).evaluate(element => element.getAnimations({ subtree: true }).length))
		.toBe(0);
	await expect(deck(page).getByRole("status")).toHaveText("Decision 2 of 3: Scope");
});

test("selecting Decisions resumes at the deck's current top card", async ({ join }) => {
	let page = await join("ana");
	await ask(page);
	await deck(page).getByRole("button", { name: "Next decision" }).click();
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await decisionsButton(page).click();
	await expect(top(page)).toBeFocused();
	await expect(top(page).getByRole("heading", { name: "What belongs in the first cut?" }))
		.toBeVisible();
});
