// e2e/unfold-previews.e2e.ts
import { seedChildChannel } from "./database";
import {
	markResearchPublished,
	seedCompletedResearchWorkspace,
} from "./research-recovery-database";
import { expect, test } from "./room";
import { researchReportSource } from "../apps/server/src/research/publication";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Page } from "@playwright/test";

const QUESTION = "Compare the evidence for a stable research document.";
const SOURCE = { title: "Primary public source", url: "https://example.com/source" };

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

async function readyResearch(
	baseURL: string,
	room: string,
	seed: (source: string, state?: SeedState) => Promise<void>,
): Promise<string> {
	let databasePort = port(baseURL);
	let title = `Preview research ${room.slice(0, 8)}`;
	let workspaceId = `workspace-${crypto.randomUUID()}`;
	let report = {
		title,
		summary: "A complete report grounded in the discovered sources.",
		findings: [{ text: "The source supports the report.", sourceUrls: [SOURCE.url] }],
		caveats: ["The evidence has a limited scope."],
	};
	let child = await seedChildChannel(
		databasePort,
		room,
		crypto.randomUUID(),
		title,
		researchReportSource(report, [SOURCE]),
	);
	await seed(`# Parent document\n\n<Research id="${workspaceId}" />\n`);
	await seedCompletedResearchWorkspace(databasePort, room, {
		workspaceId,
		question: QUESTION,
		report: {
			title,
			summary: report.summary,
			finding: report.findings[0]!.text,
			caveat: report.caveats[0]!,
			source: SOURCE,
		},
	});
	await markResearchPublished(databasePort, room, workspaceId, child.id);
	return title;
}

async function preview(page: Page, title: string) {
	let card = page.getByRole("article", { name: "Research" }).filter({ hasText: title });
	await expect(card).toHaveAttribute("data-stage", "ready");
	let toggle = card.getByRole("button", { name: `Preview ${title}`, exact: true });
	let id = await toggle.getAttribute("aria-controls");
	expect(id).toBeTruthy();
	return { card, panel: `[id="${id}"]`, toggle };
}

/** Clicks the panel's trigger on the given frames and records the panel height every frame. */
function sampleFold(
	page: Page,
	panel: string,
	clicks: number[],
	frames: number,
): Promise<number[]> {
	return page.evaluate(({ clicks, frames, panel }) =>
		new Promise<number[]>(resolve => {
			let element = document.querySelector<HTMLElement>(panel)!;
			let trigger = document.querySelector<HTMLElement>(
				`[aria-controls="${CSS.escape(element.id)}"]`,
			)!;
			let heights: number[] = [];
			let frame = () => {
				if (clicks.includes(heights.length)) trigger.click();
				heights.push(element.getBoundingClientRect().height);
				if (heights.length < frames) requestAnimationFrame(frame);
				else resolve(heights);
			};
			requestAnimationFrame(frame);
		}), { clicks, frames, panel });
}

test("a research preview unfolds by keyboard without opening the report", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	let { card, toggle } = await preview(page, title);
	let child = page.getByRole("region", { name: `Child document: ${title}` });
	let open = card.getByRole("button", { name: `Open ${title}`, exact: true });
	let source = card.getByRole("link", { name: SOURCE.title, exact: true });

	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(source).toBeHidden();
	await toggle.focus();
	await page.keyboard.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(toggle).toBeFocused();
	await expect(source).toBeVisible();
	await expect(source).toHaveAttribute("href", SOURCE.url);
	await expect(card.getByText(QUESTION, { exact: true })).toBeVisible();
	await expect(child).toHaveCount(0);
	// Prose list defaults must not leak into the designed source list.
	let list = card.getByRole("list");
	expect(
		await list.evaluate(element => {
			let style = getComputedStyle(element);
			return [style.listStyleType, style.paddingInlineStart];
		}),
	).toEqual(["none", "0px"]);

	await page.keyboard.press("Tab");
	await expect(source).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(toggle).toBeFocused();
	await page.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(source).toBeHidden();

	// A folded preview takes no tab stop; the next one is the card's own open action.
	await page.keyboard.press("Tab");
	await expect(open).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(child).toBeVisible();
});

test("pressing preview text still opens the report fully", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	let { card, toggle } = await preview(page, title);

	await toggle.click();
	await expect(page.getByRole("region", { name: `Child document: ${title}` })).toHaveCount(0);
	let question = card.getByText(QUESTION, { exact: true });
	await expect(question).toBeVisible();
	// Wait out the unfold so the click lands where the text finally rests.
	let rest = "";
	await expect.poll(async () => {
		let now = JSON.stringify(await question.boundingBox());
		let steady = now === rest;
		rest = now;
		return steady;
	}).toBe(true);
	let box = await question.boundingBox();
	await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
	await expect(page.getByRole("region", { name: `Child document: ${title}` })).toBeVisible();
});

test("a preview folds continuously and reverses from its current frame", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let { panel, toggle } = await preview(page, title);

	let opening = await sampleFold(page, panel, [0], 50);
	let full = opening.at(-1)!;
	expect(opening[0]).toBeLessThan(1);
	expect(full).toBeGreaterThan(20);
	expect(opening.filter(height => height > 1 && height < full - 1).length)
		.toBeGreaterThanOrEqual(5);
	for (let index = 1; index < opening.length; index++) {
		expect(opening[index]!).toBeGreaterThanOrEqual(opening[index - 1]! - 0.5);
	}

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect.poll(() =>
		page.locator(panel).evaluate(element => element.getBoundingClientRect().height)
	).toBeLessThan(1);

	// Open, then close again twelve frames in: the fold turns back where it is.
	let interrupted = await sampleFold(page, panel, [0, 12], 60);
	let peak = Math.max(...interrupted);
	let turn = interrupted.indexOf(peak);
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThan(full - 1);
	expect(interrupted[turn + 1]!).toBeGreaterThan(peak * 0.6);
	for (let index = turn + 1; index < interrupted.length; index++) {
		expect(interrupted[index]!).toBeLessThanOrEqual(interrupted[index - 1]! + 0.5);
	}
	expect(interrupted.at(-1)!).toBeLessThan(1);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("reduced motion snaps the fold and keeps the crossfade", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	let { panel, toggle } = await preview(page, title);

	await page.emulateMedia({ reducedMotion: "no-preference" });
	await toggle.click();
	await expect.poll(async () => {
		let samples = await sampleFold(page, panel, [], 2);
		return samples[1]! - samples[0]!;
	}).toBe(0);
	let full = (await sampleFold(page, panel, [], 1))[0]!;
	await toggle.click();
	await expect.poll(async () => (await sampleFold(page, panel, [], 1))[0]!).toBeLessThan(1);

	await page.emulateMedia({ reducedMotion: "reduce" });
	let snapped = await sampleFold(page, panel, [0], 3);
	expect(snapped[1]!).toBeGreaterThan(full - 1);
	let timing = await page.locator(panel).evaluate(element => ({
		content: getComputedStyle(element.querySelector(".cv-unfold-content")!).transitionDuration,
		fold: getComputedStyle(element).transitionDuration,
		transform: getComputedStyle(element.querySelector(".cv-unfold-content")!).transform,
	}));
	expect(timing.fold).toBe("0s");
	expect(timing.content.split(", ")[0]).toBe("0.2s");
	expect(timing.transform).toBe("none");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("folding while focus is inside the panel returns focus to the toggle", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	let { card, panel, toggle } = await preview(page, title);
	let source = card.getByRole("link", { name: SOURCE.title, exact: true });

	await toggle.click();
	await expect(source).toBeVisible();
	await source.focus();
	await expect(source).toBeFocused();
	// Fold without moving focus first, as a pointer elsewhere or a script would.
	await page.locator(`[aria-controls="${await toggle.getAttribute("aria-controls")}"]`)
		.evaluate(element => (element as HTMLElement).click());
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(toggle).toBeFocused();
	await expect(page.locator(panel)).toHaveAttribute("inert", "");
	await expect(source).toBeHidden();
});

test("using the preview leaves the editor selection alone", async ({ baseURL, join, room, seed }) => {
	let title = await readyResearch(baseURL!, room, seed);
	let page = await join("ana");
	let { card, toggle } = await preview(page, title);
	let snapshot = () =>
		page.evaluate(() => {
			let selection = window.getSelection()!;
			return {
				anchor: selection.anchorNode?.textContent ?? null,
				anchorOffset: selection.anchorOffset,
				collapsed: selection.isCollapsed,
				focusOffset: selection.focusOffset,
			};
		});

	await page.getByText("Parent document", { exact: true }).click();
	await page.keyboard.press("End");
	let before = await snapshot();
	expect(before.anchor).toContain("Parent document");

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(await snapshot()).toEqual(before);

	let popup = page.waitForEvent("popup");
	await card.getByRole("link", { name: SOURCE.title, exact: true }).click();
	await (await popup).close();
	await expect(page.getByRole("region", { name: `Child document: ${title}` })).toHaveCount(0);
	expect(await snapshot()).toEqual(before);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	expect(await snapshot()).toEqual(before);
});
