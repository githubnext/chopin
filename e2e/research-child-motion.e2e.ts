import { seedChildChannel } from "./database";
import {
	markResearchPublished,
	seedCompletedResearchWorkspace,
} from "./research-recovery-database";
import { expect, test } from "./room";
import { researchReportSource } from "../apps/server/src/research/publication";

import type { Page } from "@playwright/test";

type Frame = {
	dim: number;
	scale: number;
	left: number;
	top: number;
	width: number;
	opacity: number;
	at: number;
	faces: number;
};

const PARENT = `# Parent document

${Array.from({ length: 12 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

async function seedReadyCard(
	baseURL: string,
	room: string,
	seed: (source: string) => Promise<unknown>,
): Promise<{ title: string }> {
	let port = Number(new URL(baseURL).port);
	let title = `Motion research ${room.slice(0, 8)}`;
	let workspaceId = `workspace-${crypto.randomUUID()}`;
	let answerJobId = `job-${crypto.randomUUID()}`;
	let originMessageId = crypto.randomUUID();
	let brief = "Compare the evidence for a stable research document.";
	let sources = [{ title: "Primary public source", url: "https://example.com/source" }];
	let report = {
		title,
		summary: "A complete report grounded in the discovered sources.",
		findings: [{ text: "The source supports the report.", sourceUrls: [sources[0]!.url] }],
		caveats: ["The evidence has a limited scope."],
	};
	let child = await seedChildChannel(
		port,
		room,
		crypto.randomUUID(),
		title,
		researchReportSource(report, sources),
	);
	await seed(`${PARENT}\n<Research id="${workspaceId}" />\n`);
	await seedCompletedResearchWorkspace(port, room, {
		workspaceId,
		answerJobId,
		plannerOriginMessageId: originMessageId,
		question: brief,
		report: {
			title,
			summary: report.summary,
			finding: report.findings[0]!.text,
			caveat: report.caveats[0]!,
			source: sources[0]!,
		},
	});
	await markResearchPublished(port, room, workspaceId, child.id);
	return { title };
}

/** Samples the open card's visible (clipped) box, the scrim, and the root's scale each frame. */
async function sampleFrames(page: Page, ms: number) {
	await page.evaluate(limit => {
		let frames: Frame[] = [];
		Object.assign(window, { __childFrames: frames });
		let start = performance.now();
		let sample = () => {
			let card = document.querySelector<HTMLElement>(".anchored-child-card");
			let scrim = document.querySelector<HTMLElement>(".workspace-child-scrim");
			let root = document.querySelector<HTMLElement>(
				".workspace-document-stack > .workspace-document-panel",
			);
			if (card && scrim && root) {
				let box = card.getBoundingClientRect();
				let clip = getComputedStyle(card).clipPath;
				// Computed insets collapse to the one-, two- or three-value shorthand.
				let sides = ((/^inset\(([^)]*?)(?: round|\))/.exec(clip)?.[1] ?? "")
					.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
				let [top = 0, right = top, , left = right] = sides;
				let transform = getComputedStyle(root).transform;
				frames.push({
					dim: Number(getComputedStyle(scrim).opacity),
					scale: transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a,
					left: box.left + left,
					top: box.top + top,
					width: box.width - left - right,
					opacity: Number(getComputedStyle(card).opacity),
					at: performance.now() - start,
					faces: document.querySelectorAll(".anchored-child-face").length,
				});
			}
			if (performance.now() - start < limit) requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	}, ms);
	return () => page.evaluate(() => (window as unknown as { __childFrames: Frame[] }).__childFrames);
}

async function setup(page: Page, style: "lift" | "zoom" = "lift") {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(value => {
		try {
			localStorage.setItem("chopin:dev:child-motion", value);
		} catch {}
	}, style);
}

let stackWidth = (page: Page) =>
	page.locator(".workspace-document-stack").evaluate(element =>
		element.getBoundingClientRect().width
	);

let cards = (page: Page) => page.locator(".anchored-child-card");

test("Lift grows from the research card and the dim trails the grow", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let card = opened.getByRole("article", { name: "Research" }).filter({ hasText: title });
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	let cardBox = (await card.boundingBox())!;
	let read = await sampleFrames(opened, 900);
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(950);
	let frames = await read();
	expect(frames.length).toBeGreaterThan(10);
	let first = frames[0]!;
	let last = frames.at(-1)!;
	expect(Math.abs(first.top - cardBox.y)).toBeLessThan(Math.abs(last.top - cardBox.y));
	expect(first.width).toBeLessThan((cardBox.width + last.width) / 2);
	for (let frame of frames) {
		if (frame.width <= cardBox.width + 4) expect(frame.dim).toBeLessThan(0.05);
	}
	// The dim never leads the grow.
	for (let frame of frames) {
		if (frame.at <= 80) expect(frame.dim).toBeLessThan(0.05);
	}
	expect(last.dim).toBeCloseTo(0.45, 1);
	expect(last.scale).toBeCloseTo(0.97, 2);
	let finalWidth = last.width;
	expect(finalWidth).toBeGreaterThan(cardBox.width + 100);
	let progress = (frame: Frame) => (frame.width - cardBox.width) / (finalWidth - cardBox.width);
	expect(1 - first.scale).toBeLessThanOrEqual(0.03 * Math.max(0, progress(first)) + 0.011);
	for (let frame of frames) {
		expect(1 - frame.scale).toBeLessThanOrEqual(0.03 * Math.max(0, progress(frame)) + 0.011);
	}
	// The dim, as a share of its final 0.45, never gets ahead of the grow's share.
	for (let frame of frames) expect(frame.dim / 0.45).toBeLessThanOrEqual(progress(frame) + 0.02);
	// Open progress is monotonic within tolerance.
	for (let index = 1; index < frames.length; index++) {
		expect(frames[index]!.width).toBeGreaterThanOrEqual(frames[index - 1]!.width - 2);
	}
	await expect(opened.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await expect(opened.locator(".anchored-child-face")).toHaveCount(0);
});

test("closing mid-grow shrinks from the current frame", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	let read = await sampleFrames(opened, 1200);
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(160);
	await opened.keyboard.press("Escape");
	await expect(cards(opened)).toHaveCount(0);
	await expect(opener).toBeFocused();
	await opened.waitForTimeout(300);
	let frames = await read();
	let width = await stackWidth(opened);
	for (let index = 1; index < frames.length; index++) {
		expect(Math.abs(frames[index]!.width - frames[index - 1]!.width)).toBeLessThan(width * 0.2);
	}
	expect(Math.max(...frames.map(frame => frame.width))).toBeLessThan(width * 0.98);
	await expect(opened.locator(".anchored-child-face")).toHaveCount(0);
	await expect(opened.locator("[data-child-presentation=closing]")).toHaveCount(0);
});

test("browser Back mid-open closes cleanly", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(160);
	await opened.goBack();
	await expect(cards(opened)).toHaveCount(0);
	await expect(opener).toBeFocused();
	await expect(opened.locator(".anchored-child-face")).toHaveCount(0);
	await expect(opened.locator("[data-child-presentation=closing]")).toHaveCount(0);
});

test("a settled close lands on the card's settled position", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let card = opened.getByRole("article", { name: "Research" }).filter({ hasText: title });
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(800);
	let read = await sampleFrames(opened, 600);
	await opened.keyboard.press("Escape");
	await expect(cards(opened)).toHaveCount(0);
	await expect(opener).toBeFocused();
	let cardBox = (await card.boundingBox())!;
	let frames = await read();
	let last = frames.at(-1)!;
	expect(Math.abs(last.left - cardBox.x)).toBeLessThan(4);
	expect(Math.abs(last.top - cardBox.y)).toBeLessThan(4);
	expect(Math.abs(last.width - cardBox.width)).toBeLessThan(4);
});

test("Back then Forward during a close finishes fully open", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(700);
	await opened.goBack();
	await opened.waitForTimeout(60);
	await opened.goForward();
	await opened.waitForTimeout(700);
	await expect(cards(opened)).toHaveCount(1);
	await expect(cards(opened)).toBeVisible();
	await expect.poll(() => cards(opened).evaluate(card => getComputedStyle(card).clipPath))
		.toMatch(/^(none|inset\(0px 0px 0px 0px)/);
	await expect.poll(() =>
		opened.locator(".workspace-child-scrim").evaluate(scrim => getComputedStyle(scrim).opacity)
	).toBe("0.45");
	await expect(opened.locator(".anchored-child-face")).toHaveCount(0);
	await expect(opened.locator("[data-child-presentation=closing]")).toHaveCount(0);
});

test("a sidebar row rises from the lower centre and closes by fading", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let row = opened.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: title, exact: true });
	await expect(row).toBeVisible();
	let read = await sampleFrames(opened, 900);
	await row.click();
	await expect(cards(opened)).toHaveCount(1);
	await opened.waitForTimeout(950);
	let frames = await read();
	let first = frames[0]!;
	let last = frames.at(-1)!;
	for (let frame of frames) {
		for (let value of Object.values(frame)) expect(Number.isFinite(value)).toBe(true);
	}
	let box = (await cards(opened).boundingBox())!;
	expect(Math.abs(first.left + first.width / 2 - (box.x + box.width / 2))).toBeLessThan(16);
	expect(first.top).toBeGreaterThan(box.y + box.height * 0.5);
	expect(last.width).toBeGreaterThan(first.width);
	let closing = await sampleFrames(opened, 400);
	await opened.keyboard.press("Escape");
	await expect(cards(opened)).toHaveCount(0);
	let after = await closing();
	let tail = after.slice(-6);
	expect(tail.length).toBeGreaterThan(2);
	expect(tail.at(-1)!.opacity).toBeLessThan(tail[0]!.opacity);
	for (let frame of tail) expect(Math.abs(frame.width - last.width)).toBeLessThan(2);
});

test("reduced motion crossfades without transform animation", async ({ baseURL, join, room, seed, page }) => {
	await setup(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
	let { title } = await seedReadyCard(baseURL!, room, seed);
	let opened = await join("ana");
	let opener = opened.getByRole("button", { name: `Open ${title}`, exact: true });
	await expect(opener).toBeVisible();
	await opener.click();
	await expect(cards(opened)).toHaveCount(1);
	let names = await opened.evaluate(() => {
		let found = new Set<string>();
		for (let animation of document.getAnimations()) {
			let effect = animation.effect as KeyframeEffect | null;
			let target = effect?.target;
			if (!target?.closest(".anchored-child-layer, .workspace-document-stack")) continue;
			let name = (animation as CSSAnimation).animationName;
			if (name) found.add(name);
			for (let keyframe of effect?.getKeyframes() ?? []) {
				for (let key of ["transform", "clipPath", "scale"]) {
					if (key in keyframe && keyframe[key] != null && keyframe[key] !== "none") {
						found.add(`prop:${key}`);
					}
				}
			}
		}
		return [...found];
	});
	expect(names.filter(name => name.startsWith("prop:"))).toEqual([]);
	await opened.waitForTimeout(400);
	await expect.poll(() => cards(opened).evaluate(card => getComputedStyle(card).clipPath))
		.toMatch(/^(none|inset\(0px 0px 0px 0px)/);
	await opened.keyboard.press("Escape");
	await expect(cards(opened)).toHaveCount(0);
	await expect(opener).toBeFocused();
});
