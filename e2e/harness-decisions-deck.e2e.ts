/**
 * Planner questions reaching the Decisions tab, through the real server, sockets
 * and host tools, against the isolated `AGENT=on` fake-harness project.
 */
import { chatInput } from "./chat-input";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

async function ask(page: Page, also = "") {
	let input = chatInput(page);
	await input.fill(`@chopin ASK-DECISIONS${also}`);
	await input.press("Enter");
}

const ASKED_PROMPTS = [
	"Where should room state live?",
	"What belongs in the first cut?",
	"How should we deploy?",
];

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
		if (index < 2) await expect(deck(page).locator("[data-deck-settled]")).toHaveCount(index + 1);
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

test("arrow keys page the Decisions deck; reduced motion only crossfades", async ({ join }) => {
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await ask(page);
	await deck(page).getByRole("button", { name: "Next decision" }).focus();
	await page.keyboard.press("ArrowRight");
	await expect(top(page).getByRole("heading", { name: "What belongs in the first cut?" }))
		.toBeVisible();
	// Only a crossfade: no deck animation moves a card or the stage.
	let moving = await deck(page).evaluate(element =>
		element.getAnimations({ subtree: true }).filter(animation => {
			let frames = (animation.effect as KeyframeEffect).getKeyframes();
			return new Set(frames.map(frame => frame.transform)).size > 1
				|| frames.some(frame => frame.height);
		}).length
	);
	expect(moving).toBe(0);
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

test("answered decisions with no prose leave the document blank and writable", async ({ join }) => {
	let page = await join("ana");
	await ask(page);
	await answerAll(page);
	await expect(page.getByRole("button", { name: "3 resolved" })).toBeVisible();

	await page.getByRole("button", { name: "Document", exact: true }).click();
	let plan = content(page);
	await expect(plan).toHaveAttribute("data-plan-blank", "");
	await expect(page.locator('[data-document-view="plan"] [data-card-settled]')).toHaveCount(0);
	await expect(page.getByRole("status").filter({ hasText: "Writing up" })).toHaveCount(0);
	expect(
		await plan.locator(":scope > p").first().evaluate(element =>
			getComputedStyle(element, "::before").content
		),
	).toBe('"Start writing, or ask Chopin to plan"');

	await plan.click();
	await page.keyboard.type("Notes from the call.");
	await expect(plan).toContainText("Notes from the call.");
	await expect(plan).not.toHaveAttribute("data-plan-blank");

	// Still answered, and still counted, in Decisions.
	await decisionsButton(page).click();
	await expect(page.getByRole("button", { name: "3 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(page.locator('[data-document-view="decisions"]'))
		.toContainText("Where should room state live?");
});

test("the document says once that decisions are being written up, then shows their prose", async ({ join }) => {
	let page = await join("ana");
	await ask(page, " THEN-WRITE");
	await expect(deck(page)).toBeVisible();
	// Answered in the document, so the wait is seen where the prose will land.
	await page.getByRole("button", { name: "Document", exact: true }).click();
	let inline = page.locator('[data-document-view="plan"] [data-deck-top]');
	for (let index = 0; index < 3; index++) {
		await inline.getByText("First option", { exact: true }).click();
		await inline.getByRole("button", { name: "Save", exact: true }).click();
		if (index < 2) await expect(inline).toContainText(ASKED_PROMPTS[index + 1]!);
	}

	let writing = page.locator('[data-document-view="plan"] [data-plan-writing-up]');
	await expect(writing).toHaveCount(1);
	await expect(writing).toHaveText("Writing up 3 decisions…");
	await expect(page.locator('[data-document-view="plan"] [data-card-settled]')).toHaveCount(0);
	await expect(content(page)).not.toHaveAttribute("data-plan-blank");

	await expect(content(page)).toContainText("Storage: we chose the first option.");
	await expect(page.getByRole("button", { name: "Decision: First option" }).first()).toBeVisible();
	await expect(page.locator('[data-document-view="plan"] [data-plan-collapsed]')).toHaveCount(3);
	await expect(writing).toHaveCount(0);
});
