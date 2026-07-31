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

function thread(page: import("@playwright/test").Page) {
	return page.locator("article[data-plan-sidecar-thread]");
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

test("a marked passage arrives as a thread quoting the prose", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let card = thread(page);
	await expect(card).toHaveCount(1);
	await expect(card).toContainText("@dev");
	await expect(card).toContainText(`Is this still right? — "${QUOTED}"`);
	await expect(card.getByPlaceholder("Reply…")).toBeVisible();
});

test("the quote becomes a way back into the prose once it is anchored", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = thread(page);

	// A blockquote until there is somewhere to send a click, a button after —
	// the same rule an answer already followed, and the reason the whole card
	// is not the link.
	let quote = card.getByRole("button", { name: /— show in plan/ });
	await expect(quote).toBeVisible();

	await quote.click();

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

test("a reply joins the thread", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = thread(page);

	await card.getByPlaceholder("Reply…").fill("Still right, but say why.");
	await card.getByRole("button", { name: "Reply" }).click();

	await expect(card).toContainText("Still right, but say why.");
	await expect(card).toContainText("@ana");
});

test("accepting asks twice, and says so in the transcript", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = thread(page);

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

	// Frozen: the thread is what the room settled, so there is nothing left to
	// accept or reply to.
	await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
	await expect(card.getByPlaceholder("Reply…")).toHaveCount(0);
	await expect(card).toContainText("Accepted by @ana");
});

test("a dismissed thread leaves the sidecar", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = thread(page);

	await card.getByRole("button", { name: "Dismiss" }).click();
	await card.getByRole("button", { name: "Sure?" }).click();

	await expect(thread(page)).toHaveCount(0);
});
