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
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";

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
 * A transcript's thumb, pointed at so it shows and takes the pointer: how much of it can be seen
 * and reached, against its lane and against the floor it is never drawn shorter than. `pane` is main
 * Chat's column or a thread's panel; every column and row the thumb paints must be its own.
 */
async function transcriptThumb(
	page: Page,
	at: "start" | "end",
	expected: Record<string, unknown>,
	pane = ".chat-split-main",
) {
	let scroller = page.locator(`${pane} [data-chat-scroll]`);
	await scroller.evaluate(
		(node, end) => node.scrollTo({ top: end ? node.scrollHeight : 0 }),
		at === "end",
	);
	await scroller.hover({ position: { x: 40, y: 40 } });
	await expect(page.locator(`${pane} .chat-scroll-track`)).toHaveAttribute("data-pointed", "");
	await expect.poll(() =>
		scroller.evaluate(node => {
			let lane = node.parentElement!.querySelector<HTMLElement>(".chat-scroll-track")!;
			let bar = lane.firstElementChild as HTMLElement;
			let track = lane.getBoundingClientRect();
			let thumb = bar.getBoundingClientRect();
			let card = node.closest(".chat-main, [data-thread-panel]")!
				.querySelector("[data-chat-runs], [data-thread-runs]")!.getBoundingClientRect();
			// The ink is inside the thumb's transparent border.
			let inset = Number.parseFloat(getComputedStyle(bar).borderLeftWidth);
			let hidden = 0;
			// Whole pixels: Chromium takes any fraction past one as the next pixel's hit.
			for (let x = Math.ceil(thumb.left + inset); x < thumb.right - inset; x++) {
				for (let y = Math.ceil(thumb.top + inset); y < thumb.bottom - inset; y++) {
					if (document.elementFromPoint(x, y) !== bar) hidden++;
				}
			}
			return {
				// The thumb is drawn whole, its every painted point reached by the pointer.
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
async function thumbWhole(page: Page, pane?: string) {
	let whole = { hidden: 0, drawn: true, clearOfCard: true };
	await transcriptThumb(page, "end", { ...whole, fromStart: expect.any(Number), fromEnd: 0 }, pane);
	await transcriptThumb(
		page,
		"start",
		{ ...whole, fromStart: 0, fromEnd: expect.any(Number) },
		pane,
	);
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

/**
 * A thread's own transcript and runs come only from its Planner, so the socket hands the browser a
 * thread already long and running: every thread opened gets `replies` replies and `runs`.
 */
async function longThreads(page: Page, replies: number, runs: Chat.Run[]) {
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as Chat.ThreadOpened;
			if (frame.kind !== "chat:thread" || !frame.root) return route.send(message);
			let entries = Array.from({ length: replies }, (_, index) =>
				({
					id: `reply-${index}`,
					author: { kind: "member", handle: index % 2 ? "bo" : "ana" },
					text: `Reply ${index + 1}: a thought long enough to wrap in a narrow thread column.`,
					ts: frame.root.ts + (index + 1) * 60_000,
				}) as Chat.Entry);
			route.send(JSON.stringify({ ...frame, entries: [...frame.entries, ...entries], runs }));
		});
	});
	await page.reload();
	await ready(page);
}

async function openThread(page: Page) {
	let last = chatPane(page).locator(".chat-split-main [data-chat-message-id]").last();
	await last.locator("[data-chat-message-text]").hover();
	await last.getByRole("button", { name: "Reply in thread" }).click();
	await expect(page.locator("[data-thread-panel]")).toBeVisible();
	await expect(page.locator("[data-thread-panel] [data-chat-message-id]")).toHaveCount(61);
}

/**
 * Every resize grip (Resize Projects sidebar, Resize chat, Resize thread): where it takes the pointer,
 * its box and the reach around it, and every scroll lane on the page, Chopin's own transcript lanes
 * and the native lanes of whatever scrolls. A grip never lies over a lane, and every point of a
 * native lane is the scroller's own, so its thumb takes the pointer wherever it is drawn.
 */
async function gripsBesideLanes(page: Page) {
	return page.evaluate(() => {
		type Box = { left: number; right: number; top: number; bottom: number };
		let grips = [
			...document.querySelectorAll<HTMLElement>("[role=separator][aria-label^='Resize']"),
		]
			.filter(grip => grip.offsetParent)
			.map(grip => {
				let own = grip.getBoundingClientRect();
				let { left, right, top, bottom } = own;
				for (let part of ["::before", "::after"]) {
					let drawn = getComputedStyle(grip, part);
					if (drawn.content === "none" || drawn.content === "normal") continue;
					let start = own.left + Number.parseFloat(drawn.left);
					left = Math.min(left, start);
					right = Math.max(right, start + Number.parseFloat(drawn.width));
				}
				return { label: grip.getAttribute("aria-label")!, left, right, top, bottom };
			});
		let lanes: (Box & { lane: string; taken?: number })[] = [];
		for (
			let track of document.querySelectorAll<HTMLElement>(".chat-scroll-track:not([data-idle])")
		) {
			let where = track.closest("[data-thread-panel]") ? "thread transcript" : "Chat transcript";
			lanes.push({ lane: where, ...track.getBoundingClientRect().toJSON() });
		}
		for (let element of document.querySelectorAll<HTMLElement>("*")) {
			let style = getComputedStyle(element);
			let side = Number.parseFloat(style.borderRightWidth);
			let bar = element.offsetWidth - element.clientWidth - Number.parseFloat(style.borderLeftWidth)
				- side;
			if (!/auto|scroll/.test(style.overflowY) || bar <= 0) continue;
			if (element.scrollHeight <= element.clientHeight) continue;
			let box = element.getBoundingClientRect();
			let right = box.right - side;
			let top = box.top + Number.parseFloat(style.borderTopWidth);
			let bottom = box.bottom - Number.parseFloat(style.borderBottomWidth);
			let taken = 0;
			// Whole pixels: Chromium takes any fraction past one as the next pixel's hit.
			for (let x = Math.ceil(right - bar); x < right; x++) {
				for (let y = Math.ceil(top); y < Math.min(bottom, innerHeight); y += 4) {
					if (document.elementFromPoint(x, y) !== element) taken++;
				}
			}
			let name = element.getAttribute("aria-label")
				?? (element.closest("[data-project-sidebar]") ? "Projects" : element.className.toString());
			lanes.push({ lane: name, left: right - bar, right, top, bottom, taken });
		}
		let overlaps = grips.flatMap(grip =>
			lanes.filter(lane =>
				Math.min(grip.right, lane.right) - Math.max(grip.left, lane.left) > 0.25
				&& Math.min(grip.bottom, lane.bottom) - Math.max(grip.top, lane.top) > 0.25
			).map(lane =>
				`${grip.label} [${grip.left}, ${grip.right}] over ${lane.lane} [${lane.left}, ${lane.right}]`
			)
		);
		return {
			grips: grips.map(grip => ({ label: grip.label, reach: Math.round(grip.right - grip.left) })),
			lanes: lanes.map(lane => lane.lane).sort(),
			overlaps,
			taken: lanes.filter(lane => lane.taken).map(lane => `${lane.lane}: ${lane.taken}`),
		};
	});
}

test("no resize grip lies over a scroll lane, each still at least 12px to grab (the sidebar's 4px), and every thumb takes the pointer wherever it is drawn", async ({ join, seed }) => {
	test.setTimeout(180_000);
	await seed("# Busy\n\nA long conversation.\n", {
		transcript: messages(60),
		workflowRuns: [run("huge", 12, STORED - 12), ...["a", "b", "c", "d"].map(id => run(id, 6))],
		runStages: { huge: stored("huge", STORED), thuge: stored("thuge", STORED) },
	});
	let threadRuns = [run("thuge", 12, STORED - 12), ...["ta", "tb", "tc"].map(id => run(id, 6))];
	for (let [width, height] of [[1920, 1000], [1440, 900]] as const) {
		let page = await join("ana", { viewport: { width, height } });
		await longThreads(page, 60, threadRuns);
		// The Projects list long enough to scroll in its own lane.
		await page.locator("[data-project-sidebar] > .overflow-y-auto > :last-child")
			.evaluate(node => (node as HTMLElement).style.setProperty("margin-bottom", "2000px"));
		// Main Chat's every run unfolded, so its card scrolls in its own lane.
		let card = page.locator(".chat-split-main").getByRole("region", { name: "Workflow runs" });
		await card.getByRole("button", { name: /^\+\d+ more$/ }).click();
		for (let id of ["huge", "a", "b", "c", "d"]) {
			await card.getByRole("button", { name: new RegExp(`^workflow-${id},`) }).click();
		}
		let grips = { label: expect.any(String), reach: expect.any(Number) };
		let check = async (lanes: string[], labels: string[]) => {
			await page.locator(".chat-split-main [data-chat-scroll]").hover({
				position: { x: 40, y: 40 },
			});
			let found = await gripsBesideLanes(page);
			expect(found.overlaps).toEqual([]);
			expect(found.taken).toEqual([]);
			for (let lane of lanes) expect(found.lanes).toContain(lane);
			expect(found.grips.map(grip => grip.label).sort()).toEqual(labels);
			for (let grip of found.grips) {
				expect(grip).toEqual(grips);
				expect(grip.reach).toBeGreaterThanOrEqual(
					grip.label === "Resize Projects sidebar" ? 4 : 12,
				);
			}
		};
		await check(["Chat transcript", "Projects"], ["Resize Projects sidebar", "Resize chat"]);

		// A thread beside main Chat, its own runs unfolded so they scroll too (at 1440 the document
		// folds to its bar and Resize chat goes with it).
		await openThread(page);
		let threadCard = page.locator("[data-thread-panel]").getByRole("region", {
			name: "Workflow runs",
		});
		await threadCard.getByRole("button", { name: /^\+\d+ more$/ }).click();
		for (let id of ["thuge", "ta", "tb", "tc"]) {
			await threadCard.getByRole("button", { name: new RegExp(`^workflow-${id},`) }).click();
		}
		await page.locator("[data-thread-panel] [data-chat-scroll]").hover({
			position: { x: 40, y: 40 },
		});
		await check(
			["Chat transcript", "Projects"],
			width === 1920
				? ["Resize Projects sidebar", "Resize chat", "Resize thread"]
				: ["Resize Projects sidebar", "Resize thread"],
		);
		await thumbWhole(page);
		await thumbWhole(page, "[data-thread-panel]");
	}
});

/** A finger held on a message, which brings up its toolbar on a touch screen. */
async function longPress(page: Page, target: Locator): Promise<void> {
	let box = (await target.boundingBox())!;
	let point = { x: box.x + 24, y: box.y + Math.min(8, box.height / 2) };
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

const PHONE: BrowserContextOptions = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
};

/**
 * On a touch screen the thumb shows only while the pane scrolls and the finger scrolls the rows
 * under it, so it is read from its box: inside its lane, at the lane's end, drawn at its floor or
 * taller, with its lane above the runs card.
 */
async function touchThumb(page: Page, pane: string) {
	let scroller = page.locator(`${pane} [data-chat-scroll]`);
	await scroller.evaluate(node => node.scrollTo({ top: 0 }));
	await scroller.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
	await expect(page.locator(`${pane} .chat-scroll-track`)).toHaveAttribute("data-scrolling", "");
	return scroller.evaluate(node => {
		let lane = node.parentElement!.querySelector<HTMLElement>(".chat-scroll-track")!;
		let bar = lane.firstElementChild as HTMLElement;
		let track = lane.getBoundingClientRect();
		let thumb = bar.getBoundingClientRect();
		let card = node.closest(".chat-main, [data-thread-panel]")!
			.querySelector("[data-chat-runs], [data-thread-runs]")!.getBoundingClientRect();
		return {
			drawn: Math.round(thumb.height) >= Number.parseFloat(getComputedStyle(bar).minHeight),
			fromEnd: Math.round(track.bottom - thumb.bottom) || 0,
			inside: thumb.top >= track.top - 0.5 && thumb.right <= track.right + 0.5,
			clearOfCard: track.bottom <= card.top + 0.5,
			inView: track.bottom <= innerHeight && thumb.left >= 0 && thumb.right <= innerWidth,
		};
	});
}

for (
	let [layout, options] of [
		["a phone", PHONE],
		["a compact window", { viewport: { width: 640, height: 800 } }],
		["the dark theme", { colorScheme: "dark", viewport: { width: 1280, height: 700 } }],
	] as const
) {
	test(`in ${layout} the transcript's thumb is whole above the runs card, in Chat and in a thread with runs of its own`, async ({ join, seed }) => {
		test.setTimeout(150_000);
		await seed("# Busy\n\nA long conversation.\n", {
			transcript: messages(60),
			workflowRuns: [run("huge", 12, STORED - 12), ...["a", "b"].map(id => run(id, 6))],
			runStages: { huge: stored("huge", STORED), thuge: stored("thuge", STORED) },
		});
		let page = await join("ana", options);
		await longThreads(page, 60, [run("thuge", 12, STORED - 12), run("ta", 6)]);
		if (layout === "the dark theme") {
			await page.evaluate(() => document.documentElement.classList.add("dark"));
		}
		let touch = layout === "a phone";
		if (layout !== "the dark theme") {
			await page.getByRole("navigation", { name: "Workspace view" })
				.getByRole("button", { name: /^Chat/ }).click();
		}
		let whole = { drawn: true, fromEnd: 0, inside: true, clearOfCard: true, inView: true };
		let card = page.locator(".chat-split-main").getByRole("region", { name: "Workflow runs" });
		await expect(card).toBeVisible();
		let press = (target: Locator) => touch ? target.tap() : target.click();
		await press(card.getByRole("button", { name: /^workflow-huge,/ }));
		if (touch) expect(await touchThumb(page, ".chat-split-main")).toEqual(whole);
		else await thumbWhole(page);

		// A thread opens as a sheet here, beside Chat on the desktop.
		let last = chatPane(page).locator(".chat-split-main [data-chat-message-id]").last();
		await last.scrollIntoViewIfNeeded();
		if (touch) await longPress(page, last.locator("[data-chat-message-text]"));
		else await last.locator("[data-chat-message-text]").hover();
		await press(last.getByRole("button", { name: "Reply in thread" }));
		let thread = page.locator("[data-thread-panel]");
		await expect(thread.locator("[data-chat-message-id]")).toHaveCount(61);
		let threadCard = thread.getByRole("region", { name: "Workflow runs" });
		await press(threadCard.getByRole("button", { name: /^workflow-thuge,/ }));
		if (touch) expect(await touchThumb(page, "[data-thread-panel]")).toEqual(whole);
		else await thumbWhole(page, "[data-thread-panel]");
	});
}
