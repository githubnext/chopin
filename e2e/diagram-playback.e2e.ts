/**
 * A SeeCode diagram plays its entrance for the reader looking at it. One a long way down the
 * document, which nobody has scrolled to, opens on its whole drawing instead, as it does under
 * reduced motion: playing it would rewrite its step counter and controls inside the editor for
 * nothing, and each rewrite makes the editor read the page's layout.
 */

import { content, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

let diagram = {
	type: "architecture",
	nodes: [
		{ id: "project", label: "Project", row: 0, col: 0 },
		{ id: "cli", label: "CLI", row: 0, col: 1 },
		{ id: "deps", label: "Dependencies", row: 1, col: 1 },
		{ id: "builder", label: "Builder", row: 0, col: 2 },
		{ id: "dist", label: "Output", row: 0, col: 3 },
		{ id: "release", label: "Release", row: 1, col: 3 },
	],
	edges: [
		["project", "cli", "installs"],
		["cli", "deps", "requires"],
		["builder", "cli", "runs"],
		["builder", "dist", "produces"],
		["release", "dist", "copies"],
	],
};
const FENCE = `\`\`\`seecode\n${JSON.stringify(diagram)}\n\`\`\``;
/** Several screens of prose, so a diagram after it is well beyond a screen of the first view. */
const PROSE = "A paragraph of the specification, long enough to take a line of its own.\n\n".repeat(
	150,
);

/**
 * Every text each diagram's step counter has shown, by the diagram's place in the document, read
 * at every change inside a diagram: a step the page never showed is not in it.
 */
async function watchCounters(page: Page) {
	await page.addInitScript(() => {
		let seen: Record<number, string[]> = {};
		Object.defineProperty(window, "__counters", { get: () => seen });
		let scan = (figure: Element) => {
			let at = [...document.querySelectorAll(".plan-seecode")].indexOf(
				figure.closest(".plan-seecode")!,
			);
			let counter = figure.querySelector(".ch-diagram__step");
			let text = counter?.textContent;
			if (at < 0 || !text) return;
			let list = (seen[at] ??= []);
			if (!list.includes(text)) list.push(text);
		};
		new MutationObserver(records => {
			let figures = new Set<Element>();
			for (let record of records) {
				let target = record.target instanceof Element ? record.target : record.target.parentElement;
				let figure = target?.closest(".ch-diagram");
				if (figure) figures.add(figure);
			}
			figures.forEach(scan);
		}).observe(document, { subtree: true, childList: true, characterData: true });
	});
}

const counters = (page: Page) =>
	page.evaluate(() => (window as unknown as { __counters: Record<number, string[]> }).__counters);

/** What a reader sees of a diagram: each part's state and look, without the ids of its own copy. */
function look(figure: Locator) {
	return figure.evaluate(element => ({
		controls: [...element.querySelectorAll("button")].map(button => [
			button.getAttribute("aria-label"),
			button.getAttribute("aria-disabled"),
		]),
		counter: element.querySelector(".ch-diagram__step")?.textContent,
		status: element.querySelector(".ch-diagram__status")?.textContent,
		svg: element.querySelector("svg")?.getAttribute("class"),
		parts: [...element.querySelectorAll("svg *")].map(part => {
			let style = getComputedStyle(part);
			return [
				part.tagName,
				part.getAttribute("class"),
				part.getAttribute("aria-hidden"),
				style.opacity,
				style.animationName,
				style.strokeDashoffset,
			];
		}),
	}));
}

test("a diagram far below the reader opens on its last step; the ones in view play their entrance", async ({ join, page, seed }) => {
	await seed(
		`# Playback\n\n${FENCE}\n\nBetween the first diagram and the next.\n\n${FENCE}\n\n${PROSE}${FENCE}\n\nThe end.\n`,
	);
	await page.setViewportSize({ width: 1440, height: 900 });
	await watchCounters(page);
	await join("ana");
	let previews = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	await expect(previews).toHaveCount(3);
	let [top, below, far] = [previews.nth(0), previews.nth(1), previews.nth(2)];
	let total = Number(await top.locator("svg.sc-svg").getAttribute("data-sc-steps"));
	expect(total).toBeGreaterThan(2);
	let last = `${total} / ${total}`;
	let play = (preview: Locator) =>
		preview.getByRole("button", { name: "Play diagram", exact: true });

	// The far one is already still on its whole drawing, with its Play button: nothing is playing in it.
	await expect(play(far)).toBeVisible();
	await expect(far.locator(".ch-diagram__step")).toHaveText(last);
	// The ones in view play from their first step and hold the last when it is drawn.
	await expect(play(top)).toBeVisible({ timeout: 15_000 });
	await expect(play(below)).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1_500);

	let shown = await counters(page);
	let steps = (list: string[] | undefined) => (list ?? []).filter(text => text !== last);
	// Each step of the entrance was counted on the way for those in view, one by one...
	for (let at of [0, 1]) {
		expect(shown[at], `diagram ${at}`).toContain(last);
		expect(steps(shown[at]).length, `diagram ${at}: ${shown[at]?.join(", ")}`)
			.toBeGreaterThanOrEqual(total - 2);
	}
	// ...and the far one's counter never showed a step on the way: never anything but its last.
	expect(steps(shown[2]).filter(text => text !== `1 / ${total}`), shown[2]?.join(", ")).toEqual([]);

	// Scrolled to, it is what the others became once they had played: the same parts in the same state.
	await far.scrollIntoViewIfNeeded();
	await expect(far.locator("svg.sc-svg")).toBeVisible();
	expect(await look(far)).toEqual(await look(top));
});
