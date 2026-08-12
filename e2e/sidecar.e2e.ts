/**
 * Questionnaires and comment threads, without an agent.
 *
 * `DEV_QUESTIONS` and `DEV_COMMENTS` exist so that the whole question and
 * passage path can be exercised by a room opening rather than by a model
 * deciding to ask something. They are read from the environment on every room
 * open, so this file runs against a second server — one with them on would put
 * a question and a thread into every other suite's room.
 *
 * A comment needs prose to mark, and a new room seeds from nothing, so every
 * test here writes the plan before anybody opens it.
 */

import { content, expect, test } from "./room";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";
const TWO_BLOCKS = `${PROSE}\nA second block remains after the marked passage.\n`;
const LONG_PLAN = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");

/** What the injector will quote: the first forty-eight characters. */
const QUOTED = "Room state lives on disk as MDX beside the trans";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

function commentButton(page: import("@playwright/test").Page) {
	return page.getByRole("button", { name: /Comment on/ });
}

async function rewriteFirstBlock(page: import("@playwright/test").Page, value: string) {
	let block = content(page).locator("p").first();
	await block.selectText();
	await page.keyboard.type(value);
}

async function thread(page: import("@playwright/test").Page) {
	await commentButton(page).click();
	return page.getByRole("dialog", { name: "Comment thread" });
}

test("prose keeps Plan selected while questions arrive in Decisions", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let plan = page.getByRole("button", { name: "Plan", exact: true });
	let decisions = page.getByRole("button", { name: "Decisions", exact: true });
	await expect(plan).toHaveAttribute("aria-pressed", "true");
	await expect(decisions).toHaveAttribute("aria-pressed", "false");
	await expect(decisions).toContainText("2");

	await decisions.click();
	await expect(questionnaire(page)).toHaveCount(1);
	await expect(questionnaire(page).getByRole("heading", { name: "Storage" })).toBeVisible();
	await expect(page.locator('[data-document-view="decisions"] [data-plan-sidecar-thread]'))
		.toHaveCount(0);
});

test("a question-only document opens Decisions", async ({ page, room }) => {
	await page.goto(`/r/${room}?as=ana`);

	await expect(page.getByRole("button", { name: "Decisions", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
});

test("the waiting-question line selects Decisions", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	await page.locator("#pane-chat").getByRole("button", { name: "Answer" }).click();

	await expect(page.getByRole("button", { name: "Decisions", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(questionnaire(page)).toBeInViewport();
});

test("switching views restores the plan scroll position", async ({ join, seed }) => {
	await seed(LONG_PLAN);
	let page = await join("ana");
	let scroller = page.locator(".plan-document > div.h-full.min-h-0.overflow-auto");

	await scroller.evaluate(element => {
		element.scrollTop = 160;
		element.dispatchEvent(new Event("scroll"));
	});
	await page.getByRole("button", { name: "Decisions", exact: true }).click();
	await page.getByRole("button", { name: "Plan", exact: true }).click();
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(160);
});

test("answering both questions resolves the card and writes the decision", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: "Decisions", exact: true }).click();
	let card = questionnaire(page);

	await card.getByRole("radio", { name: /On disk as MDX/ }).check();
	await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);

	await card.getByRole("tab", { name: "Scope" }).click();
	await card.getByRole("checkbox", { name: /Anchors/ }).check();
	await card.getByRole("checkbox", { name: /Export/ }).check();
	await card.getByRole("button", { name: "Submit" }).click();

	await expect(card).toContainText("On disk as MDX");
	await expect(card).toContainText("Anchors, Export");
	await expect(card).toContainText("Answered by @ana");
	await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);
});

test("an unanswered question refuses to submit and says which", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: "Decisions", exact: true }).click();
	let card = questionnaire(page);

	await card.getByRole("tab", { name: "Scope" }).click();
	await card.getByRole("checkbox", { name: /Anchors/ }).check();
	await card.getByRole("button", { name: "Submit" }).click();

	await expect(card.getByRole("alert")).toHaveText(
		"Every question needs an answer before submitting.",
	);
	await expect(card).not.toContainText("Answered by");
});

test("cancelling asks first", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: "Decisions", exact: true }).click();
	let card = questionnaire(page);

	await card.getByRole("tab", { name: "Scope" }).click();
	await card.getByRole("button", { name: "Cancel" }).click();

	await expect(card).toContainText("Cancel without answering?");
	await card.getByRole("button", { name: "Keep it" }).click();
	await expect(card.getByRole("button", { name: "Submit" })).toBeVisible();
});

test("a marked passage has document chrome with a hover preview", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let button = commentButton(page);
	await expect(button).toBeVisible();
	await button.hover();
	await expect(page.getByRole("tooltip")).toContainText(QUOTED);

	await button.focus();
	await expect(page.getByRole("tooltip")).toBeVisible();
});

test("clicking a comment button pins its document card and preserves the related wash", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);
	await expect(card).toContainText("@dev");
	await expect(card.getByPlaceholder("Reply…")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
	card = await thread(page);

	await expect.poll(() => washed(page)).toBeGreaterThan(0);
	await content(page).hover();
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
});

test("a live text edit preserves its document comment", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");

	await rewriteFirstBlock(page, "The room has a new persistence rule.");
	await expect(content(page)).toContainText("The room has a new persistence rule.");
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
	await expect(commentButton(page)).toBeVisible();
});

test("a removed subject block moves its comment to document orphan chrome", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");

	let first = content(page).locator("p").first();
	await first.selectText();
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");

	let orphaned = page.getByRole("button", { name: "1 orphaned comments" });
	await expect(orphaned).toBeVisible();
	await orphaned.click();
	await expect(page.getByRole("dialog", { name: "Orphaned comments" })).toContainText(QUOTED);
});

function washed(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => CSS.highlights.get("plan-related")?.size ?? 0);
}

test("a reply joins the thread, and the quote counts it", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await expect(card.getByText(/repl(y|ies)$/)).toHaveCount(0);
	await card.getByPlaceholder("Reply…").fill("Still right, but say why.");
	await card.getByRole("button", { name: "Reply" }).click();
	await expect(card).toContainText("Still right, but say why.");
	await expect(card).toContainText("@ana");
	await expect(card.getByText("1 reply")).toBeVisible();
});

test("accepting asks twice, and says so in the transcript", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Accept" }).click();
	await expect(card.getByRole("button", { name: "Sure?" })).toBeVisible();
	await card.getByRole("button", { name: "Sure?" }).click();
	await expect(page.getByText(/accepted a comment on/)).toBeVisible();
	await expect(
		page.getByText("The agent is not running, so the plan has not been revised."),
	).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
	await expect(commentButton(page)).toHaveCount(0);
	await expect(content(page).getByRole("article", { name: "Decision" })).toContainText(QUOTED);
});

test("a dismissed thread removes its document button", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Dismiss" }).click();
	await card.getByRole("button", { name: "Sure?" }).click();
	await expect(commentButton(page)).toHaveCount(0);
});
