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

/** What the injector will quote: the first forty-eight characters. */
const QUOTED = "Room state lives on disk as MDX beside the trans";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator("article[data-plan-sidecar-questionnaire]");
}

function commentButton(page: import("@playwright/test").Page) {
	return page.getByRole("button", { name: /Comment on/ });
}

async function thread(page: import("@playwright/test").Page) {
	await commentButton(page).click();
	return page.getByRole("dialog", { name: "Comment thread" });
}

test("a question the room was asked is waiting in the sidecar", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let card = questionnaire(page);
	await expect(card).toHaveCount(1);
	await expect(card.getByRole("heading", { name: "Storage" })).toBeVisible();
	await expect(card).toContainText("Where should room state live?");

	// Single choice is a radio and multiple choice a checkbox, because the
	// control is the only thing that says which it is before you try.
	await expect(card.getByRole("radio", { name: /On disk as MDX/ })).toBeVisible();
	await expect(card.getByRole("radio", { name: /In SQLite/ })).toBeVisible();
});

test("the waiting-question line reopens the decisions rail", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	await page.getByRole("button", { name: "Hide decisions pane" }).click();
	await expect(page.locator("#pane-decisions")).toBeHidden();

	await page.locator("#pane-chat").getByRole("button", { name: "Answer" }).click();

	await expect(page.locator("#pane-decisions")).toBeVisible();
	await expect(questionnaire(page)).toBeInViewport();
});

test("answering both questions resolves the card and writes the decision", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = questionnaire(page);

	await card.getByRole("radio", { name: /On disk as MDX/ }).check();

	// The footer belongs to the questionnaire, not to a question, so it only
	// appears on the last tab — there is no submitting half of one.
	await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);

	await card.getByRole("tab", { name: "Scope" }).click();
	await card.getByRole("checkbox", { name: /Anchors/ }).check();
	await card.getByRole("checkbox", { name: /Export/ }).check();

	await card.getByRole("button", { name: "Submit" }).click();

	// The record owns the answer and the plan shows it. Both have to happen
	// before anyone is told it is final, so a resolved card is also a promise
	// about the document.
	await expect(card).toContainText("On disk as MDX");
	await expect(card).toContainText("Anchors, Export");
	await expect(card).toContainText("Answered by @ana");
	await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);
});

test("an unanswered question refuses to submit and says which", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = questionnaire(page);

	await card.getByRole("tab", { name: "Scope" }).click();
	await card.getByRole("checkbox", { name: /Anchors/ }).check();
	await card.getByRole("button", { name: "Submit" }).click();

	// Not a disabled button: a control that is grey for a reason it will not
	// give is worse than one that answers when pressed.
	await expect(card.getByRole("alert")).toHaveText(
		"Every question needs an answer before submitting.",
	);
	await expect(card).not.toContainText("Answered by");
});

test("cancelling asks first", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
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
	await expect(page.getByRole("tooltip")).toContainText(`Is this still right? — "${QUOTED}"`);

	// Focus offers the same compact preview without requiring a pointer.
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

	/*
	 * Read out of the highlight registry, not off an element. The wash takes no
	 * space and adds nothing to the tree — an agent editing below the fold must
	 * not shift the sentence somebody is typing in, and neither must a mark
	 * appearing beside it. `data-plan-related` is only the fallback for a
	 * browser without `CSS.highlights`, which Chromium is not.
	 */
	await expect.poll(() => washed(page)).toBeGreaterThan(0);

	// Clicking pins it, so it survives the pointer leaving; a reader sent
	// somewhere they were not looking needs it still there when they arrive.
	await content(page).hover();
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
});

/** How many ranges the shared highlight registry is painting for us. */
function washed(page: import("@playwright/test").Page): Promise<number> {
	// Document-wide and shared with Lexical's remote cursors, which are named
	// `lexical-cursor-*`. A collision would silently unpaint somebody else's.
	return page.evaluate(() => CSS.highlights.get("plan-related")?.size ?? 0);
}

test("a reply joins the thread, and the quote counts it", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	// The opening comment is not a reply, so a thread nobody has answered has
	// no number to report and shows none.
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

	// One click relabels, the second commits. Accepting starts an agent turn
	// and freezes the thread, which is not something to do on a mis-click.
	await card.getByRole("button", { name: "Accept" }).click();
	await expect(card.getByRole("button", { name: "Sure?" })).toBeVisible();
	await card.getByRole("button", { name: "Sure?" }).click();

	// An agent that begins editing for no visible reason is worse than a noisy
	// log, so the accept writes itself into the transcript first.
	await expect(page.getByText(/accepted a comment on/)).toBeVisible();

	// A gate on a message is not a gate on a button: accepting reaches
	// `Chat.instruct` directly, and under AGENT=off it has to say so rather
	// than open a session.
	await expect(
		page.getByText("The agent is not running, so the plan has not been revised."),
	).toBeVisible();

	// Open-thread chrome leaves the document as soon as the comment is settled;
	// its resulting Decision is the next task's inline surface.
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
	await expect(commentButton(page)).toHaveCount(0);
});

test("a dismissed thread removes its document button", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Dismiss" }).click();
	await card.getByRole("button", { name: "Sure?" }).click();

	await expect(commentButton(page)).toHaveCount(0);
});
