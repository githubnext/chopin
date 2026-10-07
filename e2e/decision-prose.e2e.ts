/** Browser coverage for chat decisions that become anchored document prose. */

import { content, expect, ready, test } from "./room";
import { openJevWire, sendChat, wireFrames, wireState } from "./jev-wire";
import { resetPlannerJobs, scriptJob } from "./planner-jobs";

import type { Locator, Page } from "@playwright/test";
import type { Question } from "../packages/protocol/index";

const QUESTION = "Should we ship a small pilot?";
const OPTION = "Start with a small pilot.";

function card(page: Page) {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: QUESTION }) });
}

function marker(page: Page) {
	return page.getByRole("button", { name: `Decision: ${OPTION}`, exact: true });
}

async function proseOrphaned(page: Page): Promise<boolean | undefined> {
	let id = (await wireState(page))?.threads[0]?.questionnaireId;
	let frames = await wireFrames(page);
	for (let frame of frames.toReversed()) {
		if (frame.kind === "question:meta" && frame.id === id) {
			return (frame as Question.Meta).meta.proseOrphaned;
		}
		if (frame.kind === "question:metas") {
			return (frame as Question.Metas).cards.find(card => card.id === id)?.meta.proseOrphaned;
		}
	}
	return undefined;
}

function prose(page: Page, option = OPTION) {
	return content(page).getByText(`We decided: ${option}`, { exact: true });
}

function proseBlock(page: Page) {
	return content(page).locator("p").filter({ hasText: "We decided:" });
}

async function scriptProse(option: string, target = "$target") {
	await scriptJob("prose", [{
		tool: "write_decision_prose",
		args: { revision: "$revision", id: target, text: `We decided: ${option}` },
	}]);
}

async function waitForProseJob(page: Page, status: string) {
	await expect.poll(async () => {
		let frames = await wireFrames(page);
		let current = frames.findLast(frame =>
			frame.kind === "conversation-plan:jobs" || frame.kind === "conversation-plan:snapshot"
		) as { jobs?: Array<{ kind?: string; status?: string }> } | undefined;
		return current?.jobs?.find(job => job.kind === "prose")?.status;
	}).toBe(status);
}

async function decide(page: Page, room: string, option = OPTION) {
	await scriptProse(option);
	await openJevWire(page, room);
	let source = await sendChat(page, QUESTION);
	await sendChat(page, OPTION);
	let decision = card(page);
	await expect(decision).toBeVisible();
	await decision.getByText(option, { exact: true }).click();
	await expect(decision.getByRole("radio", { name: option, exact: true })).toBeChecked();
	await decision.getByRole("button", { name: "Save", exact: true }).click();
	await expect(prose(page, option)).toBeVisible();
	await waitForProseJob(page, "done");
	return source;
}

async function openPopover(page: Page): Promise<Locator> {
	await marker(page).click();
	let popover = page.getByRole("dialog", { name: "Decision", exact: true });
	await expect(popover).toBeVisible();
	return popover;
}

test.beforeEach(async () => {
	await resetPlannerJobs();
});

test.afterEach(async () => {
	await resetPlannerJobs();
});

test("Save writes prose, collapses the card, marks its margin, and records activity", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);

	await expect(card(page)).toHaveCount(0);
	await expect(marker(page)).toBeVisible();
	await expect(page.getByText("Chopin wrote up", { exact: false })).toBeVisible();
	let [mark, paragraph] = await Promise.all([
		marker(page).boundingBox(),
		prose(page).boundingBox(),
	]);
	expect(mark).toBeTruthy();
	expect(paragraph).toBeTruthy();
	expect(mark!.x + mark!.width).toBeLessThanOrEqual(paragraph!.x);
	expect(Math.abs(mark!.y - paragraph!.y)).toBeLessThan(12);

	let hidden = page.locator('[data-document-view="plan"] [data-plan-collapsed]');
	await expect(hidden).toHaveCount(1);
	await expect(hidden).toBeHidden();
});

test("hover previews and washes prose; pin exposes source and Escape restores marker focus", async ({ join, room }) => {
	let page = await join("ana");
	let source = await decide(page, room);

	await prose(page).hover();
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText(QUESTION);
	await expect(preview).toHaveCSS("opacity", "1");
	await expect(preview).toHaveCSS("transform", "none");
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decision")?.size ?? 0))
		.toBeGreaterThan(0);

	let popover = await openPopover(page);
	await expect(popover).toHaveCSS("opacity", "1");
	await expect(popover).toHaveCSS("transform", "none");
	await expect(popover.getByRole("img", { name: "ana", exact: true })).toBeVisible();
	await expect(popover.getByText("ana", { exact: true })).toBeVisible();
	await popover.getByRole("button", { name: "Show source in chat", exact: true }).click();
	await expect(page.locator(`[data-chat-message-id="${source}"][data-source-exact="true"]`))
		.toBeVisible();

	if (!await popover.isVisible()) popover = await openPopover(page);
	await expect(popover).toBeVisible();
	await expect(marker(page)).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
	await expect(marker(page)).toBeFocused();
});

test("hiding the Document clears pinned decision chrome and its wash before marker recovery", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);
	await openPopover(page);
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decision")?.size ?? 0))
		.toBeGreaterThan(0);
	await page.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(page.locator(".plan-decision-layer [role=dialog]")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => CSS.highlights.get("plan-decision")?.size ?? 0)).toBe(
		0,
	);
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await expect(marker(page)).toBeVisible();
});

test("ordinary prose edits retain the marker; deletion orphans it for both readers after reload", async ({ join, room }) => {
	let ana = await join("ana");
	let ben = await join("ben");
	await openJevWire(ben, room);
	await decide(ana, room);
	await expect(marker(ben)).toBeVisible();

	await prose(ana).click();
	await ana.keyboard.press("End");
	await ana.keyboard.type(" For one team.");
	await expect(marker(ana)).toBeVisible();
	await expect(marker(ben)).toBeVisible();

	let edited = proseBlock(ana);
	await edited.selectText();
	await ana.keyboard.press("Backspace");
	await expect(marker(ana)).toHaveCount(0);
	await expect(marker(ben)).toHaveCount(0);
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	await ana.getByRole("button", { name: "1 resolved", exact: true }).click();
	await expect.poll(() => proseOrphaned(ana)).toBe(true);
	await expect(ana.locator('[data-document-view="decisions"]')).toContainText(OPTION);

	await ben.reload();
	await ready(ben);
	await openJevWire(ben, room);
	await ben.getByRole("button", { name: /^Decisions/ }).click();
	await ben.getByRole("button", { name: "1 resolved", exact: true }).click();
	await expect.poll(() => proseOrphaned(ben)).toBe(true);
	await expect(ben.locator('[data-document-view="decisions"]')).toContainText(OPTION);
});

test("Backspace after a hidden decided card moves into its prose without deleting the decision", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);
	let trailing = content(page).locator(":scope > p").last();
	await expect(trailing).toBeEmpty();
	await trailing.click();
	await page.keyboard.type("Following detail.");
	let following = content(page).locator("p").filter({ hasText: "Following detail." });
	await expect(following).toHaveText("Following detail.");
	await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
	await page.keyboard.press("Backspace");
	await page.keyboard.type(" Updated.");

	await expect(proseBlock(page)).toContainText(`We decided: ${OPTION} Updated.`);
	await expect(content(page)).toContainText("Following detail.");
	await expect(marker(page)).toBeVisible();
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "1 resolved", exact: true }).click();
	await expect.poll(() => proseOrphaned(page)).toBe(false);
	await page.reload();
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await expect(proseBlock(page)).toContainText(`We decided: ${OPTION} Updated.`);
	await expect(content(page)).toContainText("Following detail.");
	await expect(marker(page)).toBeVisible();
});

test("Backspace from an empty paragraph after resolved prose keeps the decision", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);
	await proseBlock(page).selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Backspace");

	await expect(content(page)).toContainText(`We decided: ${OPTION}`);
	await expect(marker(page)).toBeVisible();
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "1 resolved", exact: true }).click();
	await expect.poll(() => proseOrphaned(page)).toBe(false);
});

test("Reopen leaves prose, restores the card beneath it, and a re-decision replaces it", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);
	await sendChat(page, "Keep the pilot accessible to keyboard-only users.");

	let popover = await openPopover(page);
	await popover.getByRole("button", { name: "Reopen", exact: true }).click();
	let reopened = card(page);
	await expect(reopened).toContainText("Previously: Start with a small pilot. · @ana");
	let [paragraph, reopenedCard] = await Promise.all([
		prose(page).boundingBox(),
		reopened.boundingBox(),
	]);
	expect(paragraph).toBeTruthy();
	expect(reopenedCard).toBeTruthy();
	expect(paragraph!.y).toBeLessThan(reopenedCard!.y);

	await reopened.getByRole("button", { name: "Add an option", exact: true }).click();
	await reopened.getByRole("textbox", { name: "New option", exact: true }).fill(
		"Run a full launch",
	);
	await page.keyboard.press("Enter");
	await reopened.getByText("Run a full launch", { exact: true }).click();
	await expect(reopened.getByRole("radio", { name: "Run a full launch", exact: true }))
		.toBeChecked();
	await scriptProse("Run a full launch");
	await reopened.getByRole("button", { name: "Save", exact: true }).click();
	await expect(prose(page, "Run a full launch")).toBeVisible();
	await expect(content(page).getByText(/^We decided:/)).toHaveCount(1);
});

test("Discard removes only the marker and retains the prose", async ({ join, room }) => {
	let page = await join("ana");
	await decide(page, room);
	let popover = await openPopover(page);
	await popover.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(popover).toContainText("Discard this decision?");
	await popover.getByRole("button", { name: "Discard decision", exact: true }).click();
	await expect(marker(page)).toHaveCount(0);
	await expect(prose(page)).toBeVisible();
});

test("a narrow document retains its resolved-prose lane while the marker scrolls away", async ({ join, room }) => {
	let page = await join("ana", { viewport: { width: 800, height: 600 } });
	await decide(page, room);
	let resolved = `We decided: ${OPTION}`;
	let edited = `${resolved} Still here.`;
	await prose(page).selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type(" Still here.");
	await expect(content(page).getByText(edited, { exact: true })).toBeVisible();
	for (let index = 0; index < 32; index++) {
		await page.keyboard.press("Enter");
		await page.keyboard.type("Later implementation detail.");
	}
	expect(
		await content(page).locator("p").evaluateAll(nodes =>
			nodes.map(node => node.textContent?.trim()).find(text => text)
		),
	).toBe(edited);
	let scroller = page.locator("[data-plan-scroll]");
	let gutter = await content(page).evaluate(element =>
		Number.parseFloat(getComputedStyle(element).paddingInlineStart)
	);
	expect(gutter).toBeGreaterThan(0);
	await scroller.evaluate(element => element.scrollTop = element.scrollHeight);
	expect(
		await content(page).evaluate(element =>
			Number.parseFloat(getComputedStyle(element).paddingInlineStart)
		),
	).toBe(gutter);
	await expect(marker(page)).toHaveCount(0);
	await scroller.evaluate(element => element.scrollTop = 0);
	await expect(marker(page)).toBeVisible();
	let [mark, paragraph] = await Promise.all([
		marker(page).boundingBox(),
		proseBlock(page).boundingBox(),
	]);
	expect(mark).toBeTruthy();
	expect(paragraph).toBeTruthy();
	expect(mark!.x + mark!.width).toBeLessThanOrEqual(paragraph!.x);
});

test("a failed prose job is visible on the opening message and Retry uses the corrected script", async ({ join, room }) => {
	let page = await join("ana");
	await scriptProse(OPTION, "another-card");
	await openJevWire(page, room);
	let source = await sendChat(page, QUESTION);
	await sendChat(page, OPTION);
	await card(page).getByText(OPTION, { exact: true }).click();
	await card(page).getByRole("button", { name: "Save", exact: true }).click();
	await waitForProseJob(page, "failed");
	let opening = page.locator(`[data-chat-message-id="${source}"]`);
	await opening.getByRole("button", { name: /Message details/ }).click();
	let jobs = page.getByRole("group", { name: "Planner jobs" });
	await expect(jobs).toContainText("prose · failed");
	await scriptProse(OPTION);
	await jobs.getByRole("button", { name: "Retry prose job", exact: true }).click();
	await waitForProseJob(page, "done");
	await expect(prose(page)).toBeVisible();
});

test("the collapse has an intermediate inert state, respects reduced motion, and rapid reopen remains usable", async ({ join, room }) => {
	let page = await join("ana");
	await scriptProse(OPTION);
	await openJevWire(page, room);
	await sendChat(page, QUESTION);
	await sendChat(page, OPTION);
	let decision = card(page);
	await decision.getByText(OPTION, { exact: true }).click();
	await decision.getByRole("button", { name: "Save", exact: true }).click();
	let closing = page.locator("[data-decision-collapsing]");
	await expect(closing).toHaveCount(1);
	await expect(closing).toHaveAttribute("aria-hidden", "true");
	await expect(closing).toHaveAttribute("inert", "");
	let heights = await closing.evaluate(async element => {
		let samples: number[] = [];
		for (let index = 0; index < 4; index++) {
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			samples.push(element.getBoundingClientRect().height);
		}
		return samples;
	});
	expect(heights[0]).toBeGreaterThan(0);
	expect(heights.some(height => height > 0 && height < heights[0]!)).toBe(true);
	await expect(marker(page)).toBeVisible();
	let popover = await openPopover(page);
	await expect(closing).toHaveCount(1);
	let reopen = popover.getByRole("button", { name: "Reopen", exact: true });
	await reopen.evaluate(button => {
		document.addEventListener(
			"click",
			event => {
				if (event.composedPath().includes(button)) {
					(window as Window & { reopenedWhileClosing?: boolean }).reopenedWhileClosing =
						document.querySelector("[data-decision-collapsing]") !== null;
				}
			},
			{ capture: true, once: true },
		);
	});
	let reopenBox = await reopen.boundingBox();
	expect(reopenBox).toBeTruthy();
	await page.mouse.click(reopenBox!.x + reopenBox!.width / 2, reopenBox!.y + reopenBox!.height / 2);
	expect(
		await page.evaluate(() =>
			(window as Window & { reopenedWhileClosing?: boolean }).reopenedWhileClosing
		),
	)
		.toBe(true);
	await expect(card(page)).toBeVisible();
	await card(page).getByText(OPTION, { exact: true }).click();
	await expect(card(page).getByRole("button", { name: "Save", exact: true })).toBeEnabled();

	await page.emulateMedia({ reducedMotion: "reduce" });
	await card(page).getByText(OPTION, { exact: true }).click();
	await scriptProse(OPTION);
	await card(page).getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.locator("[data-decision-collapsing]")).toHaveCount(0);
	await expect(marker(page)).toBeVisible();
	await page.emulateMedia({ reducedMotion: "no-preference" });
});
