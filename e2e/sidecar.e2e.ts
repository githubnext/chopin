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
import { writeFile } from "node:fs/promises";
import * as Path from "node:path";

import { scratch } from "./servers";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";
const TWO_BLOCKS = `${PROSE}\nA second block remains after the marked passage.\n`;
const LONG_PLAN = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const ANCHORED = `Anchored paragraph.

<Questionnaire id="${WIDGET}" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
<Answer value="Canary" />
</Question>
</Questionnaire>
`;
const ANCHORED_DIGEST = "sha256:3ccc3e648811df8180799f8b012c6934bcf44a306f5eb8b8c9d2676b0493ccf4";

/** What the injector will quote: the first forty-eight characters. */
const QUOTED = "Room state lives on disk as MDX beside the trans";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

function commentButton(page: import("@playwright/test").Page) {
	return page.getByRole("button", { name: /Comment on “/ });
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

async function secondThread(page: import("@playwright/test").Page) {
	await content(page).locator("p").nth(1).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this block as well.");
	await draft.getByRole("button", { name: "Comment" }).click();
	await expect.poll(() => commentButton(page).count()).toBe(2);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
}

test(
	"prose opens Plan while injected questions preserve its position and selection",
	async ({ join, seed }) => {
		await seed(LONG_PLAN);
		let page = await join("ana");

		let plan = page.getByRole("button", { name: "Plan", exact: true });
		let decisions = page.getByRole("button", { name: /^Decisions/ });
		let scroller = page.locator(".plan-document > div.h-full.min-h-0.overflow-auto");
		let selected = content(page).locator("p").nth(8);
		await selected.selectText();
		await scroller.evaluate(element => {
			element.scrollTop = 160;
			element.dispatchEvent(new Event("scroll"));
		});
		let selection = await page.evaluate(() => getSelection()?.toString());
		let scrollTop = await scroller.evaluate(element => element.scrollTop);

		await expect(questionnaire(page)).toHaveCount(2);
		await expect(plan).toHaveAttribute("aria-pressed", "true");
		await expect(decisions).toHaveAttribute("aria-pressed", "false");
		await expect(decisions).toContainText("2");
		await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrollTop);
		expect(await page.evaluate(() => getSelection()?.toString())).toBe(selection);

		await decisions.click();
		await expect(questionnaire(page)).toHaveCount(2);
		await expect(questionnaire(page).getByRole("heading", { name: "Storage" })).toBeVisible();
		await expect(page.locator('[data-document-view="decisions"] [data-plan-sidecar-thread]'))
			.toHaveCount(0);
	},
);

test(
	"an unseeded room opens Decisions with the injected unanswered questions",
	async ({ page, room }) => {
		await page.goto(`/r/${room}?as=ana`);

		await expect(page.getByRole("button", { name: /^Decisions/ }))
			.toHaveAttribute("aria-pressed", "true");
		let card = questionnaire(page);
		await expect(card).toHaveCount(2);
		await expect(card.getByRole("heading", { name: "Storage" })).toBeVisible();
		await expect(card.getByRole("heading", { name: "Scope" })).toBeVisible();
		await expect(card.getByRole("tablist")).toHaveCount(0);
	},
);

test("questions leave the chat pane free of a waiting row", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	await expect(questionnaire(page)).toHaveCount(1);
	await expect(page.locator("#pane-chat")).not.toContainText("questions are waiting");
	await expect(page.locator("#pane-chat").getByRole("button", { name: "Answer" })).toHaveCount(0);

	await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.getByRole("button", { name: /^Decisions/ }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(questionnaire(page).first()).toBeInViewport();
});

test("switching views restores the plan scroll position", async ({ join, seed }) => {
	await seed(LONG_PLAN);
	let page = await join("ana");
	let scroller = page.locator(".plan-document > div.h-full.min-h-0.overflow-auto");

	await scroller.evaluate(element => {
		element.scrollTop = 160;
		element.dispatchEvent(new Event("scroll"));
	});
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "Plan", exact: true }).click();
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(160);
});

test("selecting Decisions returns to the first unanswered card after its hidden stack was scrolled", async ({ join, page: browser, seed }) => {
	await browser.setViewportSize({ width: 1280, height: 360 });
	await seed(LONG_PLAN);
	let page = await join("ana");
	let decisions = page.getByRole("button", { name: /^Decisions/ });
	let plan = page.getByRole("button", { name: "Plan", exact: true });
	let stack = page.locator('[data-document-view="decisions"] .plan-decisions > .overflow-auto');
	let first = questionnaire(page).first();

	await decisions.click();
	await expect(first).toBeFocused();

	await stack.evaluate(element => {
		element.scrollTop = element.scrollHeight;
		element.dispatchEvent(new Event("scroll"));
	});
	let scrolled = await stack.evaluate(element => element.scrollTop);
	expect(scrolled).toBeGreaterThan(0);

	await plan.click();
	await decisions.click();
	await expect(first).toBeFocused();
	await expect.poll(() => stack.evaluate(element => element.scrollTop)).toBeLessThan(scrolled);
});

test("Show in plan focuses the addressed inline questionnaire", async ({ baseURL, join, room, seed }) => {
	await seed(ANCHORED);
	await writeFile(
		Path.join(scratch(Number(new URL(baseURL!).port)), room, "state.json"),
		JSON.stringify({
			revision: 1,
			questions: [{
				id: WIDGET,
				status: "answered",
				resolver: "ana",
				definition: {
					questions: [{
						id: QUESTION,
						header: "Rollout",
						question: "How should we deploy?",
						multiple: false,
						options: [{ id: OPTION, label: "Canary", description: "" }],
					}],
				},
				answers: { [QUESTION]: "Canary" },
				anchors: {
					widget: WIDGET,
					questions: {
						[QUESTION]: {
							anchors: [{ epoch: "stale", position: "", digest: ANCHORED_DIGEST }],
							pending: false,
						},
					},
				},
			}],
		}),
	);
	let page = await join("ana");

	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "1 resolved" }).click();
	let card = questionnaire(page).filter({ hasText: "How should we deploy?" });
	await card.getByRole("button", { name: /How should we deploy.*show in plan/ }).click();

	await expect(page.getByRole("button", { name: "Plan", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(
		page.locator(
			`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
		),
	).toBeFocused();
});

test("saving one decision leaves another unanswered", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let storage = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Storage" }) });
	let scope = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });

	await storage.getByRole("radio", { name: /On disk as MDX/ }).check();
	await storage.getByRole("button", { name: "Save" }).click();
	await expect(scope).toBeVisible();
	await expect(scope.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(scope).not.toContainText("Answered by");

	await page.getByRole("button", { name: "1 resolved" }).click();
	let resolved = questionnaire(page).filter({ hasText: "Where should room state live?" });
	await expect(resolved).toContainText("On disk as MDX");
	await expect(resolved).toContainText("Answered by @ana");
	await expect(resolved.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("an unanswered question refuses to submit and says which", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });

	await card.getByRole("button", { name: "Save" }).click();

	await expect(card.getByRole("alert")).toHaveText(
		"Every question needs an answer before submitting.",
	);
	await expect(card).not.toContainText("Answered by");
});

test("cancelling asks first", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });

	await card.getByRole("button", { name: "Cancel" }).click();

	await expect(card).toContainText("Cancel without answering?");
	await card.getByRole("button", { name: "Keep it" }).click();
	await expect(card.getByRole("button", { name: "Save" })).toBeVisible();
});

test("a marked passage has document chrome with a hover preview", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let button = commentButton(page);
	await expect(button).toBeVisible();
	await button.hover();
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText(QUOTED);
	let previewId = await preview.getAttribute("id");
	expect(previewId).not.toBeNull();
	await expect(button).toHaveAttribute("aria-describedby", previewId!);

	await button.focus();
	await expect(page.getByRole("tooltip")).toBeVisible();
});

test("a wrapped passage opens its comment without intercepting text selection", async ({ join, page: browser, seed }) => {
	// The workspace leaves the document at its 400px minimum beside the
	// conversation rail, which forces the injected quote across two lines.
	await browser.setViewportSize({ width: 680, height: 600 });
	await seed(PROSE);
	let page = await join("ana");
	let hits = page.locator("[data-plan-comment-hit]");

	await expect.poll(() => hits.count()).toBeGreaterThan(1);
	let hit = await hits.first().boundingBox();
	expect(hit).not.toBeNull();
	let point = { x: hit!.x + hit!.width / 2, y: hit!.y + hit!.height / 2 };

	await page.mouse.move(point.x, point.y);
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText(QUOTED);
	let pageBox = await page.locator(".plan-document").boundingBox();
	let previewBox = await preview.boundingBox();
	expect(pageBox).not.toBeNull();
	expect(previewBox).not.toBeNull();
	expect(previewBox!.x).toBeGreaterThanOrEqual(pageBox!.x);
	expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(pageBox!.x + pageBox!.width);

	await page.mouse.click(point.x, point.y);
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();
	await page.keyboard.press("Escape");

	// The hit region observes clicks at the document host; it cannot become a
	// glass pane that eats the native drag Lexical uses to select prose.
	await page.mouse.move(hit!.x + 3, point.y);
	await page.mouse.down();
	await page.mouse.move(hit!.x + hit!.width - 3, point.y, { steps: 8 });
	await page.mouse.up();
	expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
});

test("leaving a second comment gutter clears its preview", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");
	await secondThread(page);

	let hit = await page.locator("[data-plan-comment-hit]").first().boundingBox();
	expect(hit).not.toBeNull();
	await page.mouse.move(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
	await expect(page.getByRole("tooltip")).toBeVisible();

	await commentButton(page).nth(1).hover();
	await expect(page.getByRole("tooltip")).toBeVisible();
	let blank = await content(page).locator("p").nth(1).boundingBox();
	expect(blank).not.toBeNull();
	await page.mouse.move(blank!.x + blank!.width - 4, blank!.y + blank!.height / 2);
	await expect(page.getByRole("tooltip")).toHaveCount(0);
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
	await expect(commentButton(page)).toHaveAccessibleDescription("1 reply waiting.");
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
	await expect(content(page).locator("article").filter({ hasText: QUOTED })).toContainText(QUOTED);
});

test("a dismissed thread removes its document button", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Dismiss" }).click();
	await card.getByRole("button", { name: "Sure?" }).click();
	await expect(commentButton(page)).toHaveCount(0);
});
