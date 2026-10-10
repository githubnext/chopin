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
	+ `${SECOND}\n\n${THIRD}\n\n${"Padding paragraph.\n\n".repeat(30)}`;

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

test("a block with several comments says how many in its chip's tooltip", async ({ join, seed }) => {
	let one = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 2,
		notes: ["Is two weeks enough?"],
		resolver: "ana",
		result: [],
	});
	let two = await storedResolvedComment(SOURCE, "widen it", {
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
	let besideMarker = resolvedMarker(page, "@chopin say who goes first");
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
	await marker.click();
	await page.getByRole("dialog", { name: "Resolved comment" }).getByRole("button", {
		name: "Reopen",
	}).click();

	await expect(marker).toHaveCount(0);
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread).toContainText("Reads right now. Resolving.");
	await expect(thread.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();

	await page.reload();
	await ready(page);
	await expect(page.getByRole("button", { name: /^Comment on “review the pilot”/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Resolved comment/ })).toHaveCount(0);
});
