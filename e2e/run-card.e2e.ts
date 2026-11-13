/**
 * A long workflow run's stages unfold into a bounded lane inside its card, on a
 * desktop window and a touch phone, against the `AGENT=on` harness project.
 */
import { appendFileSync } from "node:fs";

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

/** A second, short run, so the card has a line at its top and one at its foot. */
function shortRun(): Chat.Run {
	let started = Math.floor(Date.now() / 1000) - 600;
	return {
		id: "run-short",
		name: "short-workflow",
		status: "finished",
		started,
		updated: started + 60,
		ended: started + 60,
		stages: [{
			id: "run-short:s0",
			name: "only",
			status: "completed",
			started,
			ended: started + 60,
		}],
		waiting: 0,
	};
}

test("a hovered run's line is shaded across the whole card, edge to edge, square inside its corners", async ({ join, seed }) => {
	await seed("# Runs\n", { workflowRuns: [longRun(), shortRun()] });
	let page = await join("ana", DESKTOP);
	let card = chatPane(page).getByRole("region", { name: "Workflow runs" });
	for (let name of [/^long-workflow, finished/, /^short-workflow, finished/]) {
		let toggle = card.getByRole("button", { name });
		await toggle.hover();
		let line = toggle.locator("xpath=..");
		await expect.poll(() =>
			line.evaluate(node => {
				let shade = getComputedStyle(node, "::before");
				let box = node.getBoundingClientRect();
				let frame = node.closest("[data-run-stack]")!.getBoundingClientRect();
				let left = box.left + Number.parseFloat(shade.left);
				let right = left + Number.parseFloat(shade.width);
				// Offsets are from inside the line's border: the hairline above it is its own.
				let top = box.top + node.clientTop + Number.parseFloat(shade.top);
				return {
					start: Math.round(left - frame.left),
					end: Math.round(frame.right - right),
					// The whole line, from its top to its foot.
					covers: top <= box.top + 0.5 && top + Number.parseFloat(shade.height) >= box.bottom - 0.5,
					radius: shade.borderTopLeftRadius,
					opacity: shade.opacity,
					// The card's corners round it.
					clipped: getComputedStyle(node.closest("[data-run-stack]")!).overflowX,
				};
			})
		).toEqual({ start: 0, end: 0, covers: true, radius: "0px", opacity: "1", clipped: "clip" });
		// The toggle draws no shade of its own inside it.
		await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	}
	// The second run's line meets the run above it: its shade runs under the hairline between them,
	// and the pointer on that hairline is on its line, so the pointer moving down the card passes
	// from one line's shade into the next with no band between.
	expect(
		await card.locator("[data-run-toggle]").nth(1).locator("xpath=..").evaluate(node => {
			let above = node.closest("li")!.previousElementSibling!.getBoundingClientRect();
			let box = node.getBoundingClientRect();
			let top = box.top + node.clientTop
				+ Number.parseFloat(getComputedStyle(node, "::before").top);
			let hairline = document.elementFromPoint(box.left + box.width / 2, above.bottom + 0.5);
			return {
				gap: Math.round((top - above.bottom) * 10) / 10,
				hit: hairline?.closest(".run-head") === node,
			};
		}),
	).toEqual({ gap: 0, hit: true });
	await page.mouse.move(0, 0);
	await expect.poll(() =>
		card.locator("[data-run-toggle]").first().locator("xpath=..").evaluate(node =>
			getComputedStyle(node, "::before").opacity
		)
	).toBe("0");
});

type RGB = [number, number, number];

/** The colour the page paints at each point, read from a screenshot of it. */
async function painted(page: Page, points: { x: number; y: number }[]): Promise<RGB[]> {
	let png = (await page.screenshot()).toString("base64");
	return page.evaluate(async ({ data, points }) => {
		let bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
		let bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		let context = canvas.getContext("2d", { willReadFrequently: true })!;
		context.drawImage(bitmap, 0, 0);
		let scale = bitmap.width / innerWidth;
		return points.map(({ x, y }) => {
			let d = context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
			return [d[0]!, d[1]!, d[2]!] as [number, number, number];
		});
	}, { data: png, points });
}

function linear(v: number): number {
	let c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: RGB, b: RGB): number {
	let [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return Math.round((high! + 0.05) / (low! + 0.05) * 1000) / 1000;
}

/**
 * What a hovered run line draws over its shade: each text and the chevron in its toggle, as the
 * computed colour composited over the shade's paint (with every opacity up to the line).
 */
async function inks(line: Locator, shade: RGB) {
	return line.evaluate((node, shade) => {
		let probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		let rgba = (value: string) => {
			probe.clearRect(0, 0, 1, 1);
			probe.fillStyle = value;
			probe.fillRect(0, 0, 1, 1);
			let d = probe.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
		};
		let toggle = node.querySelector("[data-run-toggle]")!;
		let parts = [...toggle.querySelectorAll<HTMLElement | SVGElement>("span, svg")]
			.filter(part =>
				part.tagName === "svg"
				|| [...part.childNodes].some(child =>
					child.nodeType === Node.TEXT_NODE && child.textContent!.trim()
				)
			);
		return parts.map(part => {
			let [r, g, b, a] = rgba(getComputedStyle(part).color);
			for (let up: Element | null = part; up && up !== node; up = up.parentElement) {
				a! *= Number.parseFloat(getComputedStyle(up).opacity);
			}
			let fg = [r!, g!, b!].map((value, index) => value * a! + shade[index]! * (1 - a!));
			return {
				text: part.tagName === "svg" ? "chevron" : part.textContent!.trim(),
				icon: part.tagName === "svg",
				fg: fg as [number, number, number],
			};
		});
	}, shade);
}

function waitingRun(): Chat.Run {
	let started = Math.floor(Date.now() / 1000) - 300;
	return {
		id: "run-wait",
		name: "short-workflow",
		status: "waiting",
		started,
		updated: started + 60,
		stages: [{ id: "run-wait:s0", name: "ask", status: "awaiting_input", started }],
		waiting: 1,
	};
}

for (let scheme of ["light", "dark"] as const) {
	test(`a hovered run's line is the same darker step as a shown Chat row, and every text and icon on it meets AA, in ${scheme}`, async ({ join, seed }) => {
		await seed("# Runs\n", {
			transcript: [{
				id: "m1",
				author: { kind: "member", handle: "bo" },
				text: "The canary held overnight.",
				ts: 1_700_000_000_000,
			}],
			// Two runs of one name carry a tag; one waits on people, in the warning ink.
			workflowRuns: [longRun(), shortRun(), waitingRun()],
		});
		let page = await join("ana", { ...DESKTOP, colorScheme: scheme });
		if (scheme === "dark") {
			await page.evaluate(() => document.documentElement.classList.add("dark"));
		}
		let card = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await expect(card.locator("[data-run-toggle]")).toHaveCount(3);
		let away = { x: 1270, y: 790 };
		await page.mouse.move(away.x, away.y);

		// A Chat row: its shade over the ground, read in the gutter before its avatar.
		let row = chatPane(page).locator(".chat-split-main [data-chat-message-id='m1']");
		let rowBox = (await row.boundingBox())!;
		let main = (await page.locator(".chat-split-main").boundingBox())!;
		let rowPoint = { x: main.x + 4, y: rowBox.y + rowBox.height / 2 };
		let [ground] = await painted(page, [rowPoint]);
		await row.locator("[data-chat-message-text]").hover();
		await expect.poll(async () => contrast((await painted(page, [rowPoint]))[0]!, ground!))
			.toBeGreaterThan(1.03);
		let [rowShade] = await painted(page, [rowPoint]);
		let rowStep = contrast(rowShade!, ground!);

		// Each run line: its shade over the card, read inside the card's edge, before the toggle.
		let frame = (await card.boundingBox())!;
		for (let index of [0, 1, 2]) {
			let line = card.locator("[data-run-toggle]").nth(index).locator("xpath=..");
			let lineBox = (await line.boundingBox())!;
			let point = { x: frame.x + 4, y: lineBox.y + lineBox.height / 2 };
			await page.mouse.move(away.x, away.y);
			await expect.poll(() => line.evaluate(node => getComputedStyle(node, "::before").opacity))
				.toBe("0");
			let [page_] = await painted(page, [point]);
			await line.locator("[data-run-toggle]").hover();
			await expect.poll(() => line.evaluate(node => getComputedStyle(node, "::before").opacity))
				.toBe("1");
			let [shade] = await painted(page, [point]);
			let step = contrast(shade!, page_!);
			// As far darker than the card as a shown Chat row is than Chat.
			expect({ line: index, step: Math.round(step * 100) / 100 })
				.toEqual({ line: index, step: expect.any(Number) });
			expect(Math.abs(step - rowStep), `run step ${step}, Chat row step ${rowStep}`)
				.toBeLessThanOrEqual(0.01);
			let drawn = await inks(line, shade!);
			// The name, the status, the age and the chevron at least.
			expect(drawn.length).toBeGreaterThanOrEqual(4);
			if (process.env.HOVER_CONTRAST_OUT) {
				appendFileSync(
					process.env.HOVER_CONTRAST_OUT,
					`${
						JSON.stringify({
							scheme,
							line: index,
							step,
							rowStep,
							inks: drawn.map(ink => ({ text: ink.text, ratio: contrast(ink.fg, shade!) })),
						})
					}\n`,
				);
			}
			for (let ink of drawn) {
				let ratio = contrast(ink.fg, shade!);
				expect({
					...ink,
					ratio,
					threshold: ink.icon ? 3 : 4.5,
					meets: ratio >= (ink.icon ? 3 : 4.5),
				})
					.toEqual({ ...ink, ratio, threshold: ink.icon ? 3 : 4.5, meets: true });
			}
		}
	});
}
