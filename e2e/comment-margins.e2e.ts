/**
 * Comments in the margins: commented prose washed at rest, and resolved threads
 * that led to edits standing in the decision lane beside what they wrote.
 *
 * Highlights, geometry, hover and the pin are browser behaviour; the pure
 * pieces (tones, which threads get markers, stacking, the preview line) are in
 * `places.test.ts` and `resolved.test.ts`.
 */

import { createHash } from "node:crypto";

import { storedResolvedComment } from "../apps/server/src/testing/plan";
import { content, expect, ready, test } from "./room";

import type { Page } from "@playwright/test";

const FIRST = "The rollout goes team by team, starting with the docs team.";
const SECOND = "After two weeks we review the pilot and decide whether to widen it.";
const THIRD = "Support writes the runbook before anyone outside the pilot joins.";
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const AT = "2026-09-23T15:13:00.000Z";
const LABELS = ["All at once", "Team by team"];

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(`${text}\n`).digest("hex")}`;
}

function optionId(index: number): string {
	return `${QUESTION.slice(0, 22)}${QUESTION.slice(-2)}0${index}`;
}

// Blocks: 0 FIRST, 1 the questionnaire, 2 SECOND, 3 THIRD, then padding.
const SOURCE = `${FIRST}\n\n`
	+ `<Questionnaire id="${WIDGET}" by="ana" at="${AT}">\n`
	+ `<Question id="${QUESTION}" header="Rollout" prompt="How should we roll this out?" multiple="false">\n`
	+ LABELS.map((label, index) => `<Option id="${optionId(index)}" label="${label}" />`).join("\n")
	+ `\n<Answer value="Team by team" />\n</Question>\n</Questionnaire>\n\n`
	+ `${SECOND}\n\n${THIRD}\n\n${"Padding paragraph.\n\n".repeat(60)}`;

const DECISION = {
	id: WIDGET,
	status: "answered",
	definition: {
		questions: [{
			id: QUESTION,
			header: "Rollout",
			question: "How should we roll this out?",
			multiple: false,
			options: LABELS.map((label, index) => ({ id: optionId(index), label, description: "" })),
		}],
	},
	answers: { [QUESTION]: "Team by team" },
	resolver: "ana",
	at: Date.parse(AT) / 1_000,
	anchors: {
		widget: WIDGET,
		questions: {
			[QUESTION]: {
				anchors: [{ epoch: "stale", position: "", digest: digest(FIRST) }],
				pending: false,
			},
		},
	},
};

async function threads() {
	let beside = await storedResolvedComment(SOURCE, "team by team", {
		notes: ["@chopin say who goes first", "Named the docs team as the first group."],
		resolver: "ana",
		result: [0],
	});
	let edited = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 2,
		notes: [
			"Should the review have a date?",
			"Added the two-week mark to the review.",
			"Reads right now. Resolving.",
		],
		resolver: "ana",
		result: [2],
	});
	let quiet = await storedResolvedComment(SOURCE, "runbook", {
		block: 3,
		notes: ["Fine as it is."],
		resolver: "ana",
		result: [],
	});
	return { beside, edited, quiet };
}

function sizes(page: Page) {
	return page.evaluate(() =>
		Object.fromEntries(
			["plan-comment", "plan-comment-hover", "plan-comment-open", "plan-comment-resolved"]
				.map(name => [name, CSS.highlights.get(name)?.size ?? 0]),
		)
	);
}

function resolvedMarker(page: Page, text: string) {
	return page.getByRole("button", { name: `Resolved comment: ${text}` });
}

test("an open comment is washed at rest, stronger when pointed at, underlined when open", async ({ join, seed }) => {
	let open = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 2,
		notes: ["Is two weeks enough?"],
		resolver: "ana",
		result: [],
	});
	let { result: _result, quote: _quote, resolver: _resolver, at: _at, ...rest } = open.thread;
	await seed(SOURCE, {
		revision: 1,
		questions: [DECISION],
		threads: [{ ...rest, status: "open" }],
	});
	let page = await join("ana");

	await expect.poll(() => sizes(page)).toMatchObject({
		"plan-comment": 1,
		"plan-comment-hover": 0,
		"plan-comment-open": 0,
	});

	let chip = page.getByRole("button", { name: /^Comment on “review the pilot”/ });
	await expect(chip).toContainText("1");
	await chip.hover();
	await expect.poll(() => sizes(page)).toMatchObject({
		"plan-comment": 0,
		"plan-comment-hover": 1,
	});

	await chip.click();
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();
	await expect.poll(() => sizes(page)).toMatchObject({ "plan-comment-open": 1 });
	let underline = await page.evaluate(() =>
		getComputedStyle(document.body, "::highlight(plan-comment-open)").textDecorationLine
	);
	expect(underline).toContain("underline");

	await page.keyboard.press("Escape");
	await content(page).hover({ position: { x: 4, y: 4 } });
	await expect.poll(() => sizes(page)).toMatchObject({ "plan-comment": 1, "plan-comment-open": 0 });
});

test("a line with several comments says how many in its chip's tooltip", async ({ join, seed }) => {
	let one = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 2,
		notes: ["Is two weeks enough?"],
		resolver: "ana",
		result: [],
	});
	// Both passages start on the paragraph's first line, so they share one chip.
	let two = await storedResolvedComment(SOURCE, "After two weeks", {
		block: 2,
		notes: ["Who decides?"],
		resolver: "ana",
		result: [],
	});
	let opened = [one, two].map(({ thread }) => {
		let { result: _r, quote: _q, resolver: _s, at: _a, ...rest } = thread;
		return { ...rest, status: "open" };
	});
	await seed(SOURCE, { threads: opened });
	let page = await join("ana");

	let chip = page.getByRole("button", { name: /^2 comments on/ });
	await expect(chip).toContainText("2");
	await chip.hover();
	await expect(page.locator(".icon-tooltip")).toHaveText("2 comments");
	await expect.poll(() => sizes(page)).toMatchObject({
		"plan-comment": 0,
		"plan-comment-hover": 2,
	});
});

test("only a resolved comment that led to edits leaves a marker, stacked with a decision", async ({ join, seed }) => {
	let { beside, edited, quiet } = await threads();
	await seed(SOURCE, {
		revision: 1,
		questions: [DECISION],
		threads: [beside.thread, edited.thread, quiet.thread],
	});
	let page = await join("ana");

	let decision = page.getByRole("button", { name: "Decision: Team by team" });
	let besideMarker = resolvedMarker(page, "say who goes first");
	let editedMarker = resolvedMarker(page, "Should the review have a date?");
	await expect(decision).toBeVisible();
	await expect(besideMarker).toBeVisible();
	await expect(editedMarker).toBeVisible();
	await expect(page.getByRole("button", { name: /^Resolved comment/ })).toHaveCount(2);
	// Resolved comments are not washed at rest.
	await expect.poll(() => sizes(page)).toMatchObject({ "plan-comment": 0 });

	// The decision and the comment on the first block share the lane, one below the other.
	let top = (await decision.boundingBox())!;
	let below = (await besideMarker.boundingBox())!;
	expect(Math.abs(below.x - top.x)).toBeLessThan(1);
	expect(below.y).toBeGreaterThanOrEqual(top.y + top.height);

	// Amber, not the decision's green.
	let fills = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>(".plan-decision-marker .plan-decision-disc")]
			.map(disc => getComputedStyle(disc).backgroundColor)
	);
	expect(new Set(fills).size).toBe(2);

	await editedMarker.hover();
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText("Should the review have a date?");
	await expect(preview).toContainText("2 replies · Resolved by Ana · Edited by Chopin");
	await expect(preview).not.toContainText("Reads right now");
	await expect.poll(() => sizes(page)).toMatchObject({ "plan-comment-resolved": 1 });

	await editedMarker.click();
	let card = page.getByRole("dialog", { name: "Resolved comment" });
	await expect(card).toContainText("Resolved by Ana");
	await expect(card).toContainText("Reads right now. Resolving.");
	await expect(card.getByRole("button", { name: "Reopen" })).toBeVisible();
	await expect(card.getByRole("textbox")).toHaveCount(0);
	await expect(editedMarker).toHaveAttribute("aria-expanded", "true");

	// One pin between decisions and comments.
	await decision.click();
	await expect(page.getByRole("dialog", { name: "Decision" })).toBeVisible();
	await expect(card).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.mouse.move(1, 1);
	await expect.poll(() => sizes(page)).toMatchObject({ "plan-comment-resolved": 0 });

	// The keyboard opens it too, and puts focus inside.
	await besideMarker.focus();
	await page.keyboard.press("Enter");
	let pinned = page.getByRole("dialog", { name: "Resolved comment" });
	await expect(pinned).toContainText("Named the docs team as the first group.");
	await expect(pinned.getByRole("button", { name: "Close" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(pinned).toHaveCount(0);
	await expect(besideMarker).toBeFocused();
});

test("reopening a resolved comment brings its thread back to the passage", async ({ join, seed }) => {
	let { edited } = await threads();
	await seed(SOURCE, { threads: [edited.thread] });
	let page = await join("ana");

	let marker = resolvedMarker(page, "Should the review have a date?");
	await marker.focus();
	await page.keyboard.press("Enter");
	let reopen = page.getByRole("dialog", { name: "Resolved comment" }).getByRole("button", {
		name: "Reopen",
	});
	await reopen.focus();
	await page.keyboard.press("Enter");

	await expect(marker).toHaveCount(0);
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread).toContainText("Reads right now. Resolving.");
	// Focus follows the thread into its live card rather than falling to the page.
	await expect(thread.getByRole("textbox", { name: "Reply", exact: true })).toBeFocused();

	await page.reload();
	await ready(page);
	await expect(page.getByRole("button", { name: /^Comment on “review the pilot”/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Resolved comment/ })).toHaveCount(0);
});

test("a refused reopen says why and keeps focus on Reopen", async ({ join, seed }) => {
	let { edited } = await threads();
	// A document at its ceiling of open threads refuses to reopen another.
	let open = await Promise.all(
		Array.from({ length: 50 }, async (_, index) => {
			let { thread } = await storedResolvedComment(SOURCE, "Padding paragraph.", {
				block: 4 + index,
				notes: [`Open note ${index}`],
				resolver: "ana",
				result: [],
			});
			let { result: _r, quote: _q, resolver: _s, at: _a, ...rest } = thread;
			return { ...rest, status: "open" };
		}),
	);
	await seed(SOURCE, { threads: [edited.thread, ...open] });
	let page = await join("ana");

	let marker = resolvedMarker(page, "Should the review have a date?");
	await marker.click();
	let card = page.getByRole("dialog", { name: "Resolved comment" });
	let reopen = card.getByRole("button", { name: "Reopen" });
	await reopen.focus();
	await page.keyboard.press("Enter");

	await expect(card.getByRole("alert")).toHaveText(
		"Couldn’t reopen: this document has too many open comments",
	);
	await expect(reopen).toBeFocused();
	await expect(reopen).not.toHaveAttribute("aria-disabled", "true");
	await expect(marker).toBeVisible();
});

const ITEMS = [
	"Docs go first.",
	"Support follows once the runbook reads well and the docs team says the pilot held up.",
	"Everyone else joins at the end.",
];
const LONG = Array.from(
	{ length: 14 },
	(_, index) => `Sentence ${index + 1} keeps this paragraph wrapping across lines.`,
).join(" ");
const LINES = `${ITEMS.map(item => `- ${item}`).join("\n")}\n\n${LONG}\n`;

/** Select a phrase that sits inside one text node of the editor, as a reader would. */
async function selectPhrase(page: Page, phrase: string): Promise<void> {
	await content(page).evaluate((root, phrase) => {
		let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let text = node as Text;
			let at = text.data.indexOf(phrase);
			if (at < 0) continue;
			let range = document.createRange();
			range.setStart(text, at);
			range.setEnd(text, at + phrase.length);
			let selection = getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			return;
		}
		throw new Error(`no text node holds “${phrase}”`);
	}, phrase);
}

async function commentOnPhrase(page: Page, phrase: string, text: string): Promise<void> {
	await selectPhrase(page, phrase);
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Add a comment").fill(text);
	await draft.getByRole("button", { name: /^(Comment|Post comment)$/ }).click();
	await expect(draft).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
}

/** The glyph box of a phrase's first line, as the browser lays it out now. */
function phraseLine(page: Page, phrase: string) {
	return content(page).evaluate((root, phrase) => {
		let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let text = node as Text;
			let at = text.data.indexOf(phrase);
			if (at < 0) continue;
			let range = document.createRange();
			range.setStart(text, at);
			range.setEnd(text, at + phrase.length);
			let first = [...range.getClientRects()].find(rect => rect.width > 0)!;
			return { top: first.top, bottom: first.bottom };
		}
		throw new Error(`no text node holds “${phrase}”`);
	}, phrase);
}

async function chipCentre(page: Page, name: RegExp): Promise<number> {
	let chip =
		(await page.getByRole("button", { name }).locator(".plan-comment-chip").boundingBox())!;
	return chip.y + chip.height / 2;
}

for (
	let [name, viewport, hasTouch] of [
		["desktop", { width: 1_440, height: 900 }, false],
		["phone", { width: 390, height: 844 }, true],
	] as const
) {
	test(`${name}: a comment on a list's last item sits beside that item, not the first`, async ({ join, seed }) => {
		await seed(LINES);
		let page = await join("ana", { hasTouch, viewport });
		await commentOnPhrase(page, "Everyone else joins", "Which teams are left by then?");

		let line = await phraseLine(page, "Everyone else joins");
		let centre = await chipCentre(page, /^Comment on “Everyone else joins”/);
		expect(centre).toBeGreaterThanOrEqual(line.top);
		expect(centre).toBeLessThanOrEqual(line.bottom);
		if (hasTouch) {
			let hit = (await page.getByRole("button", { name: /^Comment on “Everyone else joins”/ })
				.boundingBox())!;
			expect(hit.width).toBeGreaterThanOrEqual(44);
		}
	});
}

test("a comment on a late line of a wrapped paragraph sits beside that line", async ({ join, seed }) => {
	await seed(LINES);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	await commentOnPhrase(page, "Sentence 12 keeps", "Too long?");

	let paragraph = (await content(page).locator("p").first().boundingBox())!;
	let line = await phraseLine(page, "Sentence 12 keeps");
	// The fixture has to wrap, or this proves nothing.
	expect(line.top).toBeGreaterThan(paragraph.y + 40);
	let centre = await chipCentre(page, /^Comment on “Sentence 12 keeps”/);
	expect(centre).toBeGreaterThanOrEqual(line.top);
	expect(centre).toBeLessThanOrEqual(line.bottom);

	// The open card sits at the passage too, not up at the paragraph's first line.
	await page.getByRole("button", { name: /^Comment on “Sentence 12 keeps”/ }).click();
	let dialog = page.getByRole("dialog", { name: "Comment thread" });
	await expect(dialog).toBeVisible();
	let card = (await dialog.boundingBox())!;
	let side = await dialog.getAttribute("data-side");
	let edge = side === "right" ? line.top : side === "below" ? line.bottom : line.top - card.height;
	expect(Math.abs(card.y - edge)).toBeLessThan(16);
});

test("comments on different lines of one paragraph get one chip each", async ({ join, seed }) => {
	await seed(LINES);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	await commentOnPhrase(page, "Sentence 1 keeps", "Opening line.");
	await commentOnPhrase(page, "Sentence 12 keeps", "A later line.");

	await expect(page.locator("[data-plan-comment-button]")).toHaveCount(2);
	for (let phrase of ["Sentence 1 keeps", "Sentence 12 keeps"]) {
		let line = await phraseLine(page, phrase);
		let centre = await chipCentre(page, new RegExp(`^Comment on “${phrase}”`));
		expect(centre).toBeGreaterThanOrEqual(line.top);
		expect(centre).toBeLessThanOrEqual(line.bottom);
	}
});

test("comments starting on the same line share one chip", async ({ join, seed }) => {
	await seed(LINES);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	await commentOnPhrase(page, "Sentence 1 keeps", "First thought.");
	await commentOnPhrase(page, "this paragraph wrapping", "Second thought.");

	await expect(page.locator("[data-plan-comment-button]")).toHaveCount(1);
	let chip = page.getByRole("button", { name: /^2 comments on “Sentence 1 keeps/ });
	await expect(chip.locator(".plan-comment-count")).toHaveText("2");
	let line = await phraseLine(page, "Sentence 1 keeps");
	let centre = await chipCentre(page, /^2 comments on/);
	expect(centre).toBeGreaterThanOrEqual(line.top);
	expect(centre).toBeLessThanOrEqual(line.bottom);

	// The shared chip's list stays open across a re-measure.
	await chip.click();
	let list = page.getByRole("dialog", { name: "Comments" });
	await expect(list).toBeVisible();
	await page.setViewportSize({ width: 1_400, height: 900 });
	await expect(list).toBeVisible();
	await expect(list.locator("[data-plan-comment-group-item]")).toHaveCount(2);
});
