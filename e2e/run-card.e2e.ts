/**
 * A long workflow run's stages unfold into a bounded lane inside its card, on a
 * desktop window and a touch phone, against the `AGENT=on` harness project.
 */
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

const STAGES = 18;
const UNREPORTED = 3;

/** A finished run with more stages than the card shows, a nested branch, and some never reported. */
function longRun(): Chat.Run {
	let started = Math.floor(Date.now() / 1000) - 3_600;
	let stages: Chat.RunStage[] = Array.from({ length: STAGES }, (_, index) => ({
		id: `run-long:s${index}`,
		name: `stage-${String(index + 1).padStart(2, "0")}`,
		status: "completed",
		started: started + index * 60,
		ended: started + index * 60 + 45,
	}));
	stages[2] = { ...stages[2]!, parentIds: ["run-long:s1"] };
	stages[3] = { ...stages[3]!, parentIds: ["run-long:s2"] };
	return {
		id: "run-long",
		name: "long-workflow",
		status: "finished",
		started,
		updated: started + STAGES * 60,
		ended: started + STAGES * 60,
		stages,
		earlierStages: UNREPORTED,
		waiting: 0,
	};
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function openRun(page: Page, phone: boolean): Promise<Locator> {
	if (phone) {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await expect.poll(async () => (await chatPane(page).boundingBox())?.x).toBe(0);
	}
	let card = chatPane(page).getByRole("region", { name: "Workflow runs" });
	await press(card.getByRole("button", { name: /^long-workflow, finished/ }), phone);
	return card;
}

function inside(
	inner: { x: number; y: number; width: number; height: number },
	outer: typeof inner,
) {
	expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
	expect(inner.y).toBeGreaterThanOrEqual(outer.y - 0.5);
	expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
	expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
}

async function press(target: Locator, phone: boolean): Promise<void> {
	if (phone) await target.tap();
	else await target.click();
}

/** Open the finished run, unfold every stage, check the lane, then fold it again. */
async function unfoldAndFold(page: Page, phone: boolean): Promise<void> {
	let card = await openRun(page, phone);
	let stages = card.locator("[data-run-stage]");
	await expect(stages).toHaveCount(6);

	let earlier = card.getByRole("button", {
		name: `Show ${STAGES - 6 + UNREPORTED} earlier stages`,
		exact: true,
	});
	await expect(earlier).toHaveAttribute("aria-expanded", "false");
	await expect(earlier).toContainText(`${STAGES - 6 + UNREPORTED} earlier`);
	await press(earlier, phone);

	let fewer = card.getByRole("button", { name: "Show fewer", exact: true });
	await expect(fewer).toHaveAttribute("aria-expanded", "true");
	let lane = card.getByRole("list", { name: "All stages of long-workflow" });
	await expect(fewer).toHaveAttribute("aria-controls", (await lane.getAttribute("id"))!);
	await expect(stages).toHaveCount(STAGES);
	await expect(lane.getByText(`${UNREPORTED} earlier stages were not reported`)).toBeVisible();
	await expect(stages.first()).toContainText("stage-01");
	await expect(stages.last()).toContainText(`stage-${STAGES}`);

	// The lane scrolls on its own, inside the card, which stays inside Chat and the window.
	let metrics = await lane.evaluate(element => ({
		scrollHeight: element.scrollHeight,
		clientHeight: element.clientHeight,
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
		overflowY: getComputedStyle(element).overflowY,
	}));
	expect(metrics.overflowY).toBe("auto");
	expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
	let viewport = page.viewportSize()!;
	let cardBox = (await card.boundingBox())!;
	inside((await lane.boundingBox())!, cardBox);
	inside(cardBox, (await chatPane(page).boundingBox())!);
	inside(cardBox, { x: 0, y: 0, ...viewport });

	// Keyboard: the lane takes focus and scrolls to its last stage without moving the card.
	await lane.focus();
	await page.keyboard.press("End");
	await expect.poll(() =>
		lane.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
	).toBeLessThanOrEqual(1);
	await expect(stages.last()).toBeInViewport();
	inside((await stages.last().boundingBox())!, (await lane.boundingBox())!);
	expect((await card.boundingBox())!).toEqual(cardBox);

	await press(fewer, phone);
	await expect(earlier).toHaveAttribute("aria-expanded", "false");
	await expect(stages).toHaveCount(6);
	await expect(card.getByRole("list", { name: "All stages of long-workflow" })).toHaveCount(0);
}

for (
	let [label, options, phone] of [
		["1280 × 800", DESKTOP, false],
		["a 390 × 844 touch phone", PHONE, true],
	] as Array<[string, BrowserContextOptions, boolean]>
) {
	test(`a finished run's +N earlier unfolds every stage in a scrolling lane inside the card on ${label}, and again after a reload`, async ({ join, seed }) => {
		await seed("# Long run\n\nThe workflow ran for a while.\n", { workflowRuns: [longRun()] });
		let page = await join("ana", options);
		await unfoldAndFold(page, phone);
		await page.reload();
		await ready(page);
		await unfoldAndFold(page, phone);
	});
}

const STORED = 500;

/** A finished run whose card carries its latest 12 stages while Chopin stores all 500. */
function storedRun(): { card: Chat.Run; stages: Chat.RunStage[] } {
	let started = Math.floor(Date.now() / 1000) - 7_200;
	let stages: Chat.RunStage[] = Array.from({ length: STORED }, (_, index) => ({
		id: `run-huge:s${index}`,
		name: `step-${String(index + 1).padStart(3, "0")}`,
		status: "completed",
		started: started + index * 10,
		ended: started + index * 10 + 5,
	}));
	stages[1] = { ...stages[1]!, parentIds: ["run-huge:s0"] };
	return {
		card: {
			id: "run-huge",
			name: "huge-workflow",
			status: "finished",
			started,
			updated: started + STORED * 10,
			ended: started + STORED * 10,
			stages: stages.slice(STORED - 12),
			earlierStages: STORED - 12,
			waiting: 0,
		},
		stages,
	};
}

test("a run's +N earlier loads all 500 stored stages a page at a time into its lane, and again after a reload", async ({ join, seed }) => {
	let { card, stages } = storedRun();
	await seed("# Huge run\n\nThe workflow ran for a long while.\n", {
		workflowRuns: [card],
		runStages: { "run-huge": stages },
	});
	let page = await join("ana", DESKTOP);
	let pages: string[] = [];
	page.on("request", request => {
		if (request.url().includes("/runs/run-huge/stages")) pages.push(request.url());
	});
	for (let round = 0; round < 2; round++) {
		pages.length = 0;
		let runs = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await runs.getByRole("button", { name: /^huge-workflow, finished/ }).click();
		let rows = runs.locator("[data-run-stage]");
		await expect(rows).toHaveCount(6);
		await runs.getByRole("button", { name: `Show ${STORED - 6} earlier stages`, exact: true })
			.click();
		let lane = runs.getByRole("list", { name: "All stages of huge-workflow" });
		await expect(rows).toHaveCount(STORED);
		await expect(lane.locator("[data-run-loading]")).toHaveCount(0);
		await expect(lane.locator("[data-run-unreported]")).toHaveCount(0);
		await expect(rows.first()).toContainText("step-001");
		await expect(rows.last()).toContainText(`step-${STORED}`);
		expect(pages.length).toBeGreaterThanOrEqual(3);
		expect(new Set(pages.map(url => new URL(url).searchParams.get("offset")))).toEqual(
			new Set(["0", "200", "400"]),
		);
		let metrics = await lane.evaluate(element => ({
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
		}));
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight * 10);
		await lane.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
		await expect(rows.last()).toBeInViewport();
		if (round === 0) {
			await page.reload();
			await ready(page);
		}
	}
});
