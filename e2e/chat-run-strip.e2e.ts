/**
 * Chat's run strip and the transcript above it: the transcript's scroll area, its newest message and
 * its scrollbar end at the strip's top edge however tall the strip grows, on a desktop window and a
 * touch phone, against the `AGENT=on` harness project.
 */
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function messages(count: number): Chat.Entry[] {
	return Array.from({ length: count }, (_, index) =>
		({
			id: `m${String(index).padStart(3, "0")}`,
			author: { kind: "member", handle: "bo" },
			text: `Message ${
				index + 1
			}: a line of conversation long enough to wrap in a narrow Chat column.`,
			ts: 1_700_000_000_000 + index * 60_000,
		}) as Chat.Entry);
}

function workflow(id: string, status: Chat.Run["status"], stages = 1): Chat.Run {
	let started = Math.floor(Date.now() / 1000) - 600;
	return {
		id,
		name: `workflow-${id}`,
		status,
		started,
		updated: started + 60,
		...(status === "running" ? {} : { ended: started + 60 }),
		stages: Array.from({ length: stages }, (_, index) => ({
			id: `${id}:s${index}`,
			name: `stage-${index + 1}`,
			status: status === "running" && index === stages - 1 ? "running" : "completed",
			started: started + index,
		})),
		waiting: 0,
	};
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function openChat(page: Page, phone: boolean): Promise<void> {
	if (!phone) return;
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatPane(page).boundingBox())?.x).toBe(0);
}

/** Where the transcript, its newest message and its scrollbar end, against the strip's top edge. */
function geometry(page: Page) {
	return page.evaluate(() => {
		let scroll = document.querySelector<HTMLElement>("[data-chat-scroll]")!;
		let strip = document.querySelector<HTMLElement>("[data-chat-runs]")!;
		let rows = scroll.querySelectorAll<HTMLElement>("[data-chat-message-id]");
		let track = scroll.parentElement!.querySelector<HTMLElement>(".chat-scroll-track");
		return {
			scrollBottom: scroll.getBoundingClientRect().bottom,
			stripTop: strip.getBoundingClientRect().top,
			lastBottom: rows[rows.length - 1]!.getBoundingClientRect().bottom,
			trackBottom: track?.getBoundingClientRect().bottom ?? 0,
			fromEnd: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
		};
	});
}

/** At the transcript's end its newest message, and the scrollbar, stand clear above the strip. */
async function clearOfStrip(page: Page): Promise<void> {
	await expect.poll(async () => (await geometry(page)).fromEnd).toBeLessThanOrEqual(2);
	let shape = await geometry(page);
	expect(shape.scrollBottom).toBeLessThanOrEqual(shape.stripTop + 0.5);
	expect(shape.lastBottom).toBeLessThanOrEqual(shape.stripTop + 0.5);
	expect(shape.trackBottom).toBeLessThanOrEqual(shape.stripTop + 0.5);
	// The edge's 16px fade lies on the transcript's own bottom space, under none of its text.
	expect(shape.scrollBottom - shape.lastBottom).toBeGreaterThanOrEqual(16);
}

test("a transcript that scrolls ends above the run strip, and stays on its newest message as the strip grows and shrinks", async ({ join, seed }) => {
	test.setTimeout(90_000);
	await seed("# Busy\n\nA long conversation.\n", {
		transcript: messages(40),
		workflowRuns: [
			workflow("a", "stopped", 4),
			workflow("b", "finished", 6),
			workflow("c", "failed", 3),
			workflow("d", "finished"),
		],
	});
	for (let [options, phone] of [[DESKTOP, false], [PHONE, true]] as const) {
		let page = await join(phone ? "bo" : "ana", options);
		await openChat(page, phone);
		let strip = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await expect(strip).toBeVisible();
		await clearOfStrip(page);
		// Unfolding runs, showing every run and folding them again: the newest message stays.
		await strip.getByRole("button", { name: /^workflow-a,/ }).click();
		await clearOfStrip(page);
		await strip.getByRole("button", { name: /^workflow-b, finished/ }).click();
		await clearOfStrip(page);
		await strip.getByRole("button", { name: "+1 more" }).click();
		await clearOfStrip(page);
		await strip.getByRole("button", { name: /^workflow-b, finished/ }).click();
		await strip.getByRole("button", { name: /^workflow-a,/ }).click();
		await clearOfStrip(page);
	}
});

test("however many runs are unfolded, the strip takes at most half of Chat and scrolls, keeping the transcript and composer in view", async ({ join, seed }) => {
	test.setTimeout(90_000);
	await seed("# Many runs\n\nA long conversation.\n", {
		transcript: messages(20),
		workflowRuns: ["a", "b", "c", "d", "e"].map(id => workflow(id, "finished", 6)),
	});
	for (
		let [options, phone] of [
			[{ viewport: { width: 1280, height: 600 } }, false],
			[{ hasTouch: true, isMobile: true, viewport: { width: 390, height: 664 } }, true],
		] as const
	) {
		let page = await join(phone ? "bo" : "ana", options);
		await openChat(page, phone);
		let strip = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await strip.getByRole("button", { name: "+2 more" }).click();
		for (let id of ["a", "b", "c", "d", "e"]) {
			await strip.getByRole("button", { name: new RegExp(`^workflow-${id},`) }).click();
		}
		let shape = await page.evaluate(() => {
			let main = document.querySelector<HTMLElement>("[data-chat-runs]")!.parentElement!;
			let runs = document.querySelector<HTMLElement>("[data-chat-runs]")!;
			let scroll = document.querySelector<HTMLElement>("[data-chat-scroll]")!;
			let composer = main.querySelector<HTMLElement>(".chat-composer")!;
			let box = (element: HTMLElement) => element.getBoundingClientRect();
			return {
				main: box(main).toJSON(),
				runs: box(runs).toJSON(),
				scroll: box(scroll).toJSON(),
				composer: box(composer).toJSON(),
				runsScrolls: runs.scrollHeight > runs.clientHeight,
				window: innerHeight,
			};
		});
		expect(shape.runs.height).toBeLessThanOrEqual(shape.main.height / 2 + 1);
		expect(shape.runsScrolls).toBe(true);
		expect(shape.scroll.top).toBeGreaterThanOrEqual(shape.main.top - 1);
		expect(shape.scroll.height).toBeGreaterThan(48);
		expect(shape.runs.bottom).toBeLessThanOrEqual(shape.composer.top + 0.5);
		expect(shape.composer.bottom).toBeLessThanOrEqual(shape.main.bottom + 0.5);
		expect(shape.composer.bottom).toBeLessThanOrEqual(shape.window + 0.5);
		// The last run's stages are reached by scrolling the strip itself.
		let last = strip.getByText("stage-6").last();
		await last.scrollIntoViewIfNeeded();
		await expect(last).toBeInViewport();
		await clearOfStrip(page);
	}
});
