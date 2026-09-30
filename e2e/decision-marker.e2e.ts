/**
 * A resolved decision is a margin marker beside the prose it produced.
 *
 * Geometry, hover, pinning, scrolling and the highlight registry are browser
 * behaviour, so this runs in Chromium; the pure pieces (which options were not
 * chosen, how hover and pin combine, where things sit) are in
 * `packages/editor/src/resolved.test.ts`.
 *
 * Anchors are seeded with a stale epoch and the block's digest, which is how
 * the server finds a block again after its history is gone.
 */

import { createHash } from "node:crypto";

import { authenticate, content, expect, roomPath, test } from "./room";

import type { Page } from "@playwright/test";

const FIRST = "The rollout goes team by team, starting with the docs team.";
const SECOND = "After two weeks we review the pilot and decide whether to widen it.";
const WIDGET_A = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const WIDGET_B = "01K0N4TR8K7JGM4R1J7PW4R8YK";
const QUESTION_A = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const QUESTION_B = "01K0N4V4E7Y6P4MJ5WD8XZF3B3";
const AT = "2026-09-23T15:13:00.000Z";

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(`${text}\n`).digest("hex")}`;
}

/** A ULID, which is what the dialect insists an option id is. */
function optionId(question: string, index: number): string {
	return `${question.slice(0, 22)}${question.slice(-2)}0${index}`;
}

function options(question: string, labels: string[]): string {
	return labels.map((label, index) =>
		`<Option id="${optionId(question, index)}" label="${label}" />`
	)
		.join("\n");
}

function questionnaire(
	widget: string,
	question: string,
	prompt: string,
	labels: string[],
	answer: string,
) {
	return `<Questionnaire id="${widget}" by="ana" at="${AT}">\n`
		+ `<Question id="${question}" header="Rollout" prompt="${prompt}" multiple="false">\n`
		+ `${options(question, labels)}\n`
		+ `<Answer value="${answer}" />\n`
		+ `</Question>\n</Questionnaire>\n`;
}

const LABELS_A = ["All at once", "Team by team", "Phased over a quarter"];
const LABELS_B = ["Two weeks", "A month"];

const SOURCE = `${FIRST}\n\n`
	+ questionnaire(WIDGET_A, QUESTION_A, "How should we roll this out?", LABELS_A, "Team by team")
	+ `\n${SECOND}\n\n`
	+ questionnaire(WIDGET_B, QUESTION_B, "How long is the pilot?", LABELS_B, "Two weeks")
	+ `\n${"Padding paragraph.\n\n".repeat(60)}`;

function record(
	widget: string,
	question: string,
	prompt: string,
	labels: string[],
	answer: string,
	prose: string,
) {
	let definition = {
		questions: [{
			id: question,
			header: "Rollout",
			question: prompt,
			multiple: false,
			options: labels.map((label, index) => ({
				id: optionId(question, index),
				label,
				description: "",
			})),
		}],
	};
	return {
		id: widget,
		status: "answered",
		definition,
		answers: { [question]: answer },
		resolver: "ana",
		at: Date.parse(AT) / 1_000,
		anchors: {
			widget,
			questions: {
				[question]: {
					anchors: [{ epoch: "stale", position: "", digest: digest(prose) }],
					pending: false,
				},
			},
		},
	};
}

const STATE = {
	revision: 1,
	questions: [
		record(WIDGET_A, QUESTION_A, "How should we roll this out?", LABELS_A, "Team by team", FIRST),
		record(WIDGET_B, QUESTION_B, "How long is the pilot?", LABELS_B, "Two weeks", SECOND),
	],
};

function marker(page: Page, answer = "Team by team") {
	return page.getByRole("button", { name: `Decision: ${answer}` });
}

function washed(page: Page, name = "plan-decision"): Promise<number> {
	return page.evaluate(name => CSS.highlights.get(name)?.size ?? 0, name);
}

function prose(page: Page, text: string) {
	return content(page).getByText(text, { exact: true });
}

async function open(page: Page, answer = "Team by team") {
	await page.setViewportSize({ width: 1_440, height: 900 });
	await page.getByRole("button", { name: "Hide chat pane" }).click();
	await page.getByRole("button", { name: "Collapse Projects sidebar" }).click();
	// The panes animate; a marker under a still-moving pointer would be left behind.
	let last = "";
	let steady = 0;
	await expect.poll(async () => {
		let now = JSON.stringify(await marker(page, answer).boundingBox());
		steady = now === last ? steady + 1 : 0;
		last = now;
		return steady;
	}, { intervals: [200] }).toBeGreaterThanOrEqual(3);
}

test("a linked decision is a gutter marker on its first line, with no card in the plan", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await expect(marker(page)).toBeVisible();
	await expect(
		page.locator(
			`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET_A}"]`,
		),
	).toHaveCount(0);

	let line = (await prose(page, FIRST).boundingBox())!;
	let box = (await marker(page).boundingBox())!;
	expect(box.x + box.width).toBeLessThanOrEqual(line.x);
	let lineCentre = line.y + 16;
	expect(Math.abs(box.y + box.height / 2 - lineCentre)).toBeLessThan(14);
	expect(box.width).toBe(20);
});

test("hovering the marker washes the prose and previews the decision", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await marker(page).hover();
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText("How should we roll this out?");
	await expect(preview).toContainText("Team by team");
	await expect(preview).toContainText("ana");
	// Folded away until pinned.
	expect(
		await preview.locator(".plan-decision-fold").evaluate(element =>
			element.getBoundingClientRect().height
		),
	).toBe(0);
	await expect.poll(() => washed(page)).toBeGreaterThan(0);

	await page.mouse.move(5, 5);
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await expect.poll(() => washed(page)).toBe(0);
});

test("hovering the anchored prose previews it without taking the text selection", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await prose(page, FIRST).hover();
	await expect(page.getByRole("tooltip")).toContainText("How should we roll this out?");
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
});

test("pressing the marker pins the popover, which shows what was not chosen and dismisses", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await marker(page).click();
	let dialog = page.getByRole("dialog", { name: "Decision" });
	await expect(dialog).toBeVisible();
	await expect(marker(page)).toHaveAttribute("aria-expanded", "true");
	await expect(dialog.getByText("All at once")).toBeVisible();
	await expect(dialog.getByText("Phased over a quarter")).toBeVisible();

	// Leaving the marker does not let go of a pin, or of its wash.
	await page.mouse.move(5, 5);
	await expect(dialog).toBeVisible();
	await expect.poll(() => washed(page)).toBeGreaterThan(0);

	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(0);
	await expect.poll(() => washed(page)).toBe(0);
	await expect(marker(page)).toBeFocused();

	await marker(page).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(0);
	await expect(marker(page)).toBeFocused();
	await expect.poll(() => washed(page)).toBe(0);

	await marker(page).click();
	await expect(dialog).toBeVisible();
	await page.mouse.click(5, 400);
	await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(0);
});

test("clicking the prose pins, and only one decision is pinned at a time", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await prose(page, FIRST).click();
	await expect(page.getByRole("dialog", { name: "Decision" })).toContainText("How should we roll");
	// The same prose again is not a dismissal.
	await prose(page, FIRST).click();
	await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(1);

	// The popover covers the prose below it, so the next decision is reached by its marker.
	await marker(page, "Two weeks").click();
	let dialog = page.getByRole("dialog", { name: "Decision" });
	await expect(dialog).toHaveCount(1);
	await expect(dialog).toContainText("How long is the pilot?");
	await expect(marker(page)).toHaveAttribute("aria-expanded", "false");
	await expect(marker(page, "Two weeks")).toHaveAttribute("aria-expanded", "true");
});

test("the marker is a keyboard control and its popover is reachable from it", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	await marker(page).focus();
	await expect(page.getByRole("tooltip")).toContainText("Team by team");
	await page.keyboard.press("Enter");
	let dialog = page.getByRole("dialog", { name: "Decision" });
	await expect(dialog).toBeVisible();
	// Pinning by keyboard moves focus into the popover, which is not next in tab order.
	await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Decision" })).toHaveCount(0);
	await expect(marker(page)).toBeFocused();
});

test("the marker follows its prose as the document scrolls", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await open(page);

	let before = (await marker(page, "Two weeks").boundingBox())!;
	await page.locator("[data-plan-scroll]").evaluate(element => element.scrollBy(0, 40));
	await expect.poll(async () => (await marker(page, "Two weeks").boundingBox())!.y)
		.toBeCloseTo(before.y - 40, 0);
});

test("a narrow document keeps its marker on screen and opens the popover within it", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });

	let target = marker(page);
	await expect(target).toBeVisible();
	let box = (await target.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);

	await prose(page, FIRST).click();
	let dialog = page.getByRole("dialog", { name: "Decision" });
	await expect(dialog).toBeVisible();
	let pop = (await dialog.boundingBox())!;
	expect(pop.x).toBeGreaterThanOrEqual(0);
	expect(pop.x + pop.width).toBeLessThanOrEqual(390);
});

test("a touch marker has a 44px target", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE, STATE);
	let context = await browser.newContext({
		baseURL,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		let page = await context.newPage();
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		let target = marker(page);
		await expect(target).toBeVisible();
		let box = (await target.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		await target.tap();
		await expect(page.getByRole("dialog", { name: "Decision" })).toBeVisible();
	} finally {
		await context.close();
	}
});

test("a decision with no prose keeps a compact card instead of a marker", async ({ join, seed }) => {
	let orphan = {
		...STATE.questions[0]!,
		anchors: { widget: WIDGET_A, questions: { [QUESTION_A]: { anchors: [], pending: false } } },
	};
	await seed(SOURCE, { revision: 1, questions: [orphan, STATE.questions[1]] });
	let page = await join("ana");
	await open(page, "Two weeks");

	await expect(marker(page)).toHaveCount(0);
	await expect(
		page.locator(
			`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET_A}"]`,
		),
	).toBeVisible();
	await expect(marker(page, "Two weeks")).toBeVisible();
});
