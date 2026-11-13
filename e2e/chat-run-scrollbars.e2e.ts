/**
 * Every scrollbar in and around Chat's workflow runs card is drawn whole: the transcript's own thumb
 * above the card, the card's lane once it takes half of Chat, and a run's lane of every stage, at
 * the transcript's end and at its start, as the card grows, and with a thread open beside it.
 *
 * The browser keeps the system's classic scrollbars here (Playwright hides them in headless
 * Chromium), where a native bar takes a lane of its own, so whatever cuts a lane off shows. The
 * transcript's thumb is Chopin's own, drawn over its rows; the transcript is long enough that the
 * thumb is held at its floor, which is where it was moved past its lane's end.
 */
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

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

const STORED = 120;

function run(id: string, stages: number, earlier = 0): Chat.Run {
	let started = Math.floor(Date.now() / 1000) - 3_600;
	return {
		id,
		name: `workflow-${id}`,
		status: "finished",
		started,
		updated: started + 60,
		ended: started + 60,
		stages: Array.from({ length: stages }, (_, index) => ({
			id: `${id}:s${earlier + index}`,
			name: `stage-${earlier + index + 1}`,
			status: "completed",
			started: started + index,
			ended: started + index + 5,
		})),
		...(earlier ? { earlierStages: earlier } : {}),
		waiting: 0,
	};
}

function stored(id: string, count: number): Chat.RunStage[] {
	let started = Math.floor(Date.now() / 1000) - 7_200;
	return Array.from({ length: count }, (_, index) => ({
		id: `${id}:s${index}`,
		name: `stage-${index + 1}`,
		status: "completed",
		started: started + index * 10,
		ended: started + index * 10 + 5,
	}));
}

function chatPane(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/**
 * The transcript's thumb, pointed at so it shows and takes the pointer: how much of it can be seen
 * and reached, against its lane and against the floor it is never drawn shorter than.
 */
async function transcriptThumb(page: Page, at: "start" | "end", expected: Record<string, unknown>) {
	let scroller = page.locator(".chat-split-main [data-chat-scroll]");
	await scroller.evaluate(
		(node, end) => node.scrollTo({ top: end ? node.scrollHeight : 0 }),
		at === "end",
	);
	await scroller.hover({ position: { x: 40, y: 40 } });
	await expect(page.locator(".chat-split-main .chat-scroll-track"))
		.toHaveAttribute("data-pointed", "");
	await expect.poll(() =>
		scroller.evaluate(node => {
			let lane = node.parentElement!.querySelector<HTMLElement>(".chat-scroll-track")!;
			let bar = lane.firstElementChild as HTMLElement;
			let track = lane.getBoundingClientRect();
			let thumb = bar.getBoundingClientRect();
			let card = node.closest(".chat-main")!.querySelector("[data-chat-runs]")!
				.getBoundingClientRect();
			let x = thumb.left + thumb.width / 2;
			let hidden = 0;
			for (let y = Math.ceil(thumb.top) + 0.5; y < thumb.bottom; y++) {
				if (document.elementFromPoint(x, y) !== bar) hidden++;
			}
			return {
				// The thumb is drawn whole, its every row reached by the pointer.
				hidden,
				drawn: Math.round(thumb.height) >= Number.parseFloat(getComputedStyle(bar).minHeight),
				// Inside its lane, at the lane's start or end as the transcript is.
				fromStart: Math.round(thumb.top - track.top) || 0,
				fromEnd: Math.round(track.bottom - thumb.bottom) || 0,
				// The lane ends above the card.
				clearOfCard: track.bottom <= card.top + 0.5,
			};
		})
	).toEqual(expected);
}

/**
 * A native scrollbar's lane down a scroller's end, between the lane's end margins: the rows, across
 * its whole width, that the scroller does not draw, because a box or a rounded corner around it clips
 * it or something drawn over it covers it. A separator's grip reaches past its line with an empty
 * pseudo-element so a pointer finds it easily; that reach draws nothing, so it covers nothing.
 */
async function nativeLane(scroller: Locator) {
	await scroller.evaluate(node => node.scrollIntoView({ block: "nearest" }));
	return scroller.evaluate(node => {
		let element = node as HTMLElement;
		let style = getComputedStyle(element);
		let box = element.getBoundingClientRect();
		let side = Number.parseFloat(style.borderRightWidth);
		let bar = element.offsetWidth - element.clientWidth - Number.parseFloat(style.borderLeftWidth)
			- side;
		// The track stops this far short of each end (theme.css), where it draws nothing.
		let probe = document.createElement("div");
		probe.style.height = "var(--scrollbar-end-margin)";
		document.body.append(probe);
		let margin = probe.offsetHeight;
		probe.remove();
		// Whether a pseudo-element of `hit` draws at the point: one placed beside its box, as a grip's
		// reach is, draws only what it fills.
		let draws = (hit: Element, part: "::before" | "::after", x: number, y: number) => {
			let drawn = getComputedStyle(hit, part);
			if (drawn.content === "none" || drawn.content === "normal") return false;
			let own = hit.getBoundingClientRect();
			let left = own.left + Number.parseFloat(drawn.left);
			let top = own.top + Number.parseFloat(drawn.top);
			let at = drawn.position !== "absolute"
				|| x >= left && x < left + Number.parseFloat(drawn.width)
					&& y >= top && y < top + Number.parseFloat(drawn.height);
			let blank = drawn.backgroundImage === "none" && drawn.boxShadow === "none"
				&& /^rgba\(.*, 0\)$/.test(drawn.backgroundColor)
				&& Number.parseFloat(drawn.borderTopWidth) + Number.parseFloat(drawn.borderLeftWidth) === 0;
			return at && !blank && drawn.opacity !== "0";
		};
		let covers = (hit: Element | null, x: number, y: number) => {
			if (hit !== element && hit && !element.contains(hit) && !hit.contains(element)) {
				let own = hit.getBoundingClientRect();
				let inside = x >= own.left && x < own.right && y >= own.top && y < own.bottom;
				return inside || draws(hit, "::before", x, y) || draws(hit, "::after", x, y);
			}
			return hit !== element;
		};
		let top = box.top + Number.parseFloat(style.borderTopWidth) + margin;
		let bottom = box.bottom - Number.parseFloat(style.borderBottomWidth) - margin;
		let hidden: number[] = [];
		let rows = 0;
		for (
			let x of [box.right - side - bar + 0.5, box.right - side - bar / 2, box.right - side - 0.5]
		) {
			for (let y = Math.ceil(top) + 0.5; y < bottom; y++) {
				rows++;
				if (covers(document.elementFromPoint(x, y), x, y)) hidden.push(Math.round(y - box.top));
			}
		}
		return {
			scrolls: element.scrollHeight > element.clientHeight,
			bar,
			rows,
			hidden: hidden.slice(0, 8),
			// Inside the window.
			inView: box.top >= 0 && box.bottom <= innerHeight,
		};
	});
}

async function laneWhole(scroller: Locator) {
	let lane = await nativeLane(scroller);
	expect(lane.scrolls).toBe(true);
	expect(lane.bar).toBeGreaterThan(0);
	expect(lane.inView).toBe(true);
	expect(lane.rows).toBeGreaterThan(0);
	expect(lane.hidden).toEqual([]);
}

/** At the transcript's end and at its start, its thumb is whole, at that end of its lane. */
async function thumbWhole(page: Page) {
	let whole = { hidden: 0, drawn: true, clearOfCard: true };
	await transcriptThumb(page, "end", { ...whole, fromStart: expect.any(Number), fromEnd: 0 });
	await transcriptThumb(page, "start", { ...whole, fromStart: 0, fromEnd: expect.any(Number) });
}

for (let [width, height] of [[1280, 700], [1440, 900]] as const) {
	test(`in a ${width} by ${height} window every scrollbar in and around the runs card is whole, as runs unfold and with a thread open`, async ({ join, seed }) => {
		test.setTimeout(120_000);
		await seed("# Busy\n\nA long conversation.\n", {
			transcript: messages(150),
			workflowRuns: [run("huge", 12, STORED - 12), ...["a", "b", "c", "d"].map(id => run(id, 6))],
			runStages: { huge: stored("huge", STORED) },
		});
		let page = await join("ana", { viewport: { width, height } });
		expect(await page.evaluate(() => document.documentElement.dataset.scrollbars)).toBe("classic");
		let card = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await expect(card).toBeVisible();

		// The card folded, then one run unfolded.
		await thumbWhole(page);
		await card.getByRole("button", { name: /^workflow-huge,/ }).click();
		await thumbWhole(page);

		// The run's every stage, in a lane of its own.
		await card.getByRole("button", { name: /^Show \d+ earlier stages$/ }).click();
		let stages = card.getByRole("list", { name: "All stages of workflow-huge" });
		await expect(stages.locator("[data-run-stage]")).toHaveCount(STORED);
		await laneWhole(stages);
		await thumbWhole(page);

		// Every run unfolded: the card takes half of Chat and scrolls in its own lane.
		await card.getByRole("button", { name: /^\+\d+ more$/ }).click();
		for (let id of ["a", "b", "c", "d"]) {
			await card.getByRole("button", { name: new RegExp(`^workflow-${id},`) }).click();
		}
		let runs = page.locator(".chat-split-main [data-chat-runs]");
		await laneWhole(runs);
		await laneWhole(stages);
		await runs.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
		await laneWhole(runs);
		await thumbWhole(page);

		// A thread open beside main Chat (at 1280 the document folds to its bar).
		let last = chatPane(page).locator(".chat-split-main [data-chat-message-id]").last();
		await last.locator("[data-chat-message-text]").hover();
		await last.getByRole("button", { name: "Reply in thread" }).click();
		await expect(page.locator("[data-thread-panel]")).toBeVisible();
		await laneWhole(runs);
		await laneWhole(stages);
		await thumbWhole(page);
	});
}
