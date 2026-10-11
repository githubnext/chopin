/**
 * The phone comment sheet: one header row, the thread on the sheet itself,
 * notes that scroll above a pinned composer, and 44px targets throughout.
 *
 * Snap sizing and the header's wording are pure and live in
 * `comment-sheet.test.ts`; geometry and the keyboard are browser behaviour.
 */

import { storedResolvedComment } from "../apps/server/src/testing/plan";
import { content, expect, openIsolatedRoom, test } from "./room";
import { expectInsideViewport } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { Browser, Locator, Page } from "@playwright/test";

const IPHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const FIRST = "The rollout goes team by team, starting with the docs team.";
const SECOND = "After two weeks we review the pilot and decide whether to widen it.";
const SOURCE = `${FIRST}\n\n${SECOND}\n\n${"Padding paragraph.\n\n".repeat(30)}`;

async function open(quote: string, notes: string[], block = 1) {
	let { thread } = await storedResolvedComment(SOURCE, quote, {
		block,
		notes,
		resolver: "ana",
		result: [],
	});
	let { result: _result, quote: _quote, resolver: _resolver, at: _at, ...rest } = thread;
	return { ...rest, status: "open" };
}

async function size(locator: Locator) {
	let box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return box!;
}

/**
 * The sheet rises with a transition; measure it once it stands still on the viewport's foot.
 * At the medium detent its foot is below the screen, so it reaches the bottom or past it.
 */
async function settled(sheet: Locator, bottom = 844) {
	let last = Number.NaN;
	await expect.poll(async () => {
		let box = await size(sheet);
		let still = Math.abs(box.y - last) < 0.5;
		last = box.y;
		return still && box.y + box.height >= bottom - 1;
	}).toBe(true);
}

/** Drag with a finger, as the drawer reads touch pointers, in small steps. */
async function drag(page: Page, from: { x: number; y: number }, by: number) {
	let cdp = await page.context().newCDPSession(page);
	let point = (y: number) => [{ x: from.x, y }];
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.y) });
	for (let step = 1; step <= 12; step++) {
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: point(from.y + (by * step) / 12),
		});
		await page.waitForTimeout(16);
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await cdp.detach();
}

async function phone(browser: Browser, baseURL: string, room: string) {
	return openIsolatedRoom(
		browser,
		baseURL,
		room,
		"ana",
		IPHONE,
		context =>
			installVisualViewport(context, {
				height: 844,
				offsetLeft: 0,
				offsetTop: 0,
				pageLeft: 0,
				pageTop: 0,
				scale: 1,
				width: 390,
			}),
	);
}

async function draft(page: Page): Promise<Locator> {
	let passage = content(page).locator("p").filter({ hasText: SECOND });
	await passage.selectText();
	let action = page.getByRole("button", { name: "Comment on this passage", exact: true });
	// A phone docks its selection actions at the foot of the screen, clear of the system's callout.
	let bar = page.getByRole("toolbar", { name: "Selection actions" });
	await bar.evaluate(element => Promise.all(element.getAnimations().map(item => item.finished)));
	let selection = await page.evaluate(() =>
		getSelection()!.getRangeAt(0).getBoundingClientRect().bottom
	);
	expect((await size(bar)).y).toBeGreaterThanOrEqual(selection);
	await action.click();
	let sheet = page.getByRole("dialog", { name: "New comment" });
	await expect(sheet.getByPlaceholder("Add a comment")).toBeFocused();
	return sheet;
}

test("a phone thread sheet quotes its passage once and holds the thread on the sheet", async ({ join, seed }) => {
	await seed(SOURCE, {
		threads: [await open("review the pilot", ["Is two weeks enough?", "Two weeks is the pilot."])],
	});
	let page = await join("ana", IPHONE);
	await page.getByRole("button", { name: /^Comment on “review the pilot”/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();
	await settled(sheet);

	// One header row: the passage, not a title and a count.
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText("review the pilot");
	await expect(sheet.getByText("Comment", { exact: true })).toHaveCount(0);
	await expect(sheet.getByText(/^\d+ comments?$/)).toHaveCount(0);

	// The thread is not a bordered card inside the sheet.
	let sheetBox = await size(sheet);
	let card = sheet.locator("[data-plan-comment-card]");
	let cardBox = await size(card);
	expect(Math.abs(cardBox.x - sheetBox.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(cardBox.width - sheetBox.width)).toBeLessThanOrEqual(1);
	expect(
		await card.evaluate(element => {
			let style = getComputedStyle(element);
			return [style.borderTopWidth, style.boxShadow, style.outlineStyle];
		}),
	).toEqual(["0px", "none", "none"]);

	// As tall as the thread, not a mostly empty large detent; the composer at its foot.
	expect(sheetBox.height).toBeLessThan(844 / 2);
	let reply = sheet.getByRole("textbox", { name: "Reply", exact: true });
	let replyBox = await size(reply);
	expect(replyBox.y + replyBox.height).toBeLessThanOrEqual(sheetBox.y + sheetBox.height);
	expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(844 + 1);

	// Actions and Send to Chopin are shown without focus, each a full touch target.
	for (
		let target of [
			sheet.getByRole("button", { name: "More actions" }),
			sheet.getByRole("button", { name: "Resolve" }),
			sheet.getByRole("button", { name: "Close comment" }),
		]
	) {
		await expect(target).toBeVisible();
		let box = await size(target);
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	let address = sheet.locator("label").filter({ hasText: "Send to Chopin" });
	await expect(address).toBeVisible();
	expect((await size(address)).height).toBeGreaterThanOrEqual(44);
	await expect(sheet.getByRole("checkbox", { name: "Send to Chopin" })).not.toBeChecked();

	// Closed by touch, the chip takes focus back without a ring around its 44px hit area.
	let marker = page.getByRole("button", { name: /^Comment on “review the pilot”/ });
	await sheet.getByRole("button", { name: "Close comment" }).tap();
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
	expect(await marker.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("none");

	// Closed from the keyboard, it keeps the ring that says where focus went.
	await marker.tap();
	await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
	expect(await marker.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe(
		"none",
	);
});

test("a long phone thread scrolls its notes and keeps the composer pinned", async ({ join, seed }) => {
	let notes = Array.from(
		{ length: 3 },
		(_, index) =>
			`Note ${index + 1}. ${"A long note that wraps over several lines on a phone. ".repeat(10)}`,
	);
	await seed(SOURCE, { threads: [await open("review the pilot", notes)] });
	let page = await join("ana", IPHONE);
	await page.getByRole("button", { name: /^Comment on “review the pilot”/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await settled(sheet);
	let scroller = sheet.locator(".plan-comment-thread-scroll");
	await expect.poll(() => scroller.evaluate(element => element.scrollHeight > element.clientHeight))
		.toBe(true);
	let sheetBox = await size(sheet);
	expect(sheetBox.height).toBeLessThanOrEqual(844 * 0.92 + 1);
	await expectInsideViewport(sheet.getByRole("textbox", { name: "Reply", exact: true }));
	await expectInsideViewport(sheet.getByRole("checkbox", { name: "Send to Chopin" }));
});

test("a phone draft sheet stands on the keyboard with Send to Chopin in reach", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let emulation = await phone(browser, baseURL!, room);
	try {
		let sheet = await draft(emulation.page);
		await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText(SECOND);
		await sheet.getByPlaceholder("Add a comment").fill("Is two weeks enough?");
		await setVisualViewport(emulation.page, { event: "resize", height: 506, offsetTop: 0 });
		await expect(async () => {
			let box = await size(sheet);
			expect(box.y + box.height).toBeLessThanOrEqual(506 + 1);
			await expectInsideViewport(sheet.getByPlaceholder("Add a comment"));
			await expectInsideViewport(sheet.getByRole("checkbox", { name: "Send to Chopin" }));
			await expectInsideViewport(sheet.getByRole("button", { name: "Post comment" }));
		}).toPass();
	} finally {
		await emulation.close();
	}
});

test("a phone list leads into a thread and back from one header row", async ({ join, seed }) => {
	await seed(SOURCE, {
		threads: [
			// Both passages start on the first line, so they share one chip.
			await open("After two weeks", ["Is two weeks enough?"]),
			await open("two weeks we", ["Who decides?"]),
		],
	});
	let page = await join("ana", IPHONE);
	await page.getByRole("button", { name: /^2 comments on/ }).tap();
	let list = page.getByRole("dialog", { name: "Comments" });
	await expect(list.getByText("2 comments", { exact: true })).toHaveCount(1);

	await list.getByRole("button", { name: /Who decides\?/ }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	let back = thread.getByRole("button", { name: "All 2 comments" });
	await expect(back).toBeFocused();
	await expect(thread.getByText("2 comments", { exact: true })).toHaveCount(0);
	expect((await size(back)).height).toBeGreaterThanOrEqual(44);
	let backBox = await size(back);
	let closeBox = await size(thread.getByRole("button", { name: "Close comment" }));
	expect(Math.abs(backBox.y + backBox.height / 2 - (closeBox.y + closeBox.height / 2)))
		.toBeLessThanOrEqual(1);

	await back.click();
	let again = page.getByRole("dialog", { name: "Comments" });
	await expect(again.getByRole("button", { name: /Who decides\?/ })).toBeFocused();
});

test("a resolved comment's marker opens its thread in the phone sheet", async ({ join, seed }) => {
	let { thread } = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 1,
		notes: ["Should the review have a date?", "Added the two-week mark to the review."],
		resolver: "ana",
		result: [1],
	});
	await seed(SOURCE, { threads: [thread] });
	let page = await join("ana", IPHONE);
	let marker = page.getByRole("button", {
		name: "Resolved comment: Should the review have a date?",
	});
	await marker.tap();
	let sheet = page.getByRole("dialog", { name: "Resolved comment" });
	await expect(sheet).toHaveAttribute("data-plan-comment-sheet");
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText("review the pilot");
	await expect(sheet).toContainText("Added the two-week mark to the review.");
	await expect(sheet.getByRole("button", { name: "Reopen" })).toBeVisible();
	await expect(page.locator(".plan-decision-pop")).toHaveCount(0);

	await sheet.getByRole("button", { name: "Close comment" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
	await expect(page.locator(".plan-decision-pop")).toHaveCount(0);
});

test("a backdrop tap closes a resolved comment's sheet with its exit and returns focus", async ({ join, seed }) => {
	let { thread } = await storedResolvedComment(SOURCE, "review the pilot", {
		block: 1,
		notes: ["Should the review have a date?", "Added the two-week mark to the review."],
		resolver: "ana",
		result: [1],
	});
	await seed(SOURCE, { threads: [thread] });
	let page = await join("ana", IPHONE);
	let marker = page.getByRole("button", {
		name: "Resolved comment: Should the review have a date?",
	});
	await marker.tap();
	let sheet = page.getByRole("dialog", { name: "Resolved comment" });
	await settled(sheet);
	let exit = page.evaluate(async () => {
		let frames: number[] = [];
		for (let index = 0; index < 40; index++) {
			await new Promise(requestAnimationFrame);
			let popup = document.querySelector("[data-plan-comment-sheet]");
			if (popup) frames.push(popup.getBoundingClientRect().y);
		}
		return frames;
	});
	await page.touchscreen.tap(195, 40);
	let frames = await exit;
	// It slides away rather than vanishing in the frame after the tap.
	expect(frames.length).toBeGreaterThan(2);
	expect(Math.max(...frames)).toBeGreaterThan(frames[0]! + 20);
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
});

test("a phone sheet keeps its passage above it as the sheet grows", async ({ join, seed }) => {
	// Deep enough in the document that it can sit where the sheet will stand.
	let low = `${"Lead paragraph.\n\n".repeat(16)}${SECOND}\n\n${
		"Padding paragraph.\n\n".repeat(30)
	}`;
	let { thread } = await storedResolvedComment(low, "review the pilot", {
		block: 16,
		notes: ["Is two weeks enough?"],
		resolver: "ana",
		result: [],
	});
	let { result: _result, quote: _quote, resolver: _resolver, at: _at, ...rest } = thread;
	await seed(low, { threads: [{ ...rest, status: "open" }] });
	let page = await join("ana", IPHONE);
	// Not by role: the modal sheet hides the editor from the accessibility tree.
	let passage = page.locator(".plan-content > p").filter({ hasText: SECOND });
	// Start with the passage low on the screen, where the sheet will stand.
	await passage.evaluate(element => {
		let scroller = element.closest("[data-plan-scroll]")!;
		let box = element.getBoundingClientRect();
		scroller.scrollTop -= innerHeight - 60 - box.bottom;
	});
	expect((await size(passage)).y).toBeGreaterThan(844 / 2);
	await page.getByRole("button", { name: /^Comment on “review the pilot”/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await settled(sheet);
	// The commented words, not their whole paragraph, are what must stay in view.
	let above = async () => {
		let sheetBox = await size(sheet);
		let bottom = await passage.evaluate(element => {
			let text = element.firstChild!;
			while (text.nodeType !== Node.TEXT_NODE) text = text.firstChild!;
			let start = text.textContent!.indexOf("review the pilot");
			let range = document.createRange();
			range.setStart(text, start);
			range.setEnd(text, start + "review the pilot".length);
			return range.getBoundingClientRect().bottom;
		});
		return bottom <= sheetBox.y;
	};
	await expect.poll(above).toBe(true);

	let reply = sheet.getByRole("textbox", { name: "Reply", exact: true });
	await reply.fill(Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join("\n"));
	await expect.poll(async () => (await size(reply)).height).toBeGreaterThan(80);
	await settled(sheet);
	await expect.poll(above).toBe(true);
});

test("a phone selection docks its actions at the foot of the screen instead of a format bar", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", IPHONE);
	let passage = content(page).locator("p").filter({ hasText: SECOND });
	await passage.selectText();
	let bar = page.getByRole("toolbar", { name: "Selection actions" });
	await expect(bar).toBeVisible();
	await bar.evaluate(element => Promise.all(element.getAnimations().map(item => item.finished)));
	// Formatting belongs to editing; the floating bubble does not appear on a phone.
	await expect(page.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Bold" })).toHaveCount(0);

	// Docked just above the tab bar, never over the selection or the lines just under it.
	let barBox = await size(bar);
	let tabs = await size(page.getByRole("navigation", { name: "Workspace view" }));
	expect(barBox.y + barBox.height).toBeGreaterThan(tabs.y - 48);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabs.y);
	let selection = await page.evaluate(() =>
		getSelection()!.getRangeAt(0).getBoundingClientRect().bottom
	);
	expect(barBox.y).toBeGreaterThan(selection);
	await expectInsideViewport(bar);
	for (let button of await bar.getByRole("button").all()) {
		let box = await size(button);
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await expect(bar.getByRole("button", { name: "Copy" })).toBeVisible();

	// Comment opens the draft with its passage left in view above the sheet.
	await bar.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let sheet = page.getByRole("dialog", { name: "New comment" });
	await expect(sheet.getByPlaceholder("Add a comment")).toBeFocused();
	await expect(bar).toHaveCount(0);
	// Not by role: the modal sheet hides the editor from the accessibility tree.
	let prose = page.locator(".plan-content > p").filter({ hasText: SECOND });
	await expect.poll(async () => {
		let sheetBox = await size(sheet);
		let proseBox = await size(prose);
		return proseBox.y + proseBox.height <= sheetBox.y && proseBox.y >= 0;
	}).toBe(true);
});

test("a desktop selection still raises the formatting bubble", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", { viewport: { width: 1_440, height: 900 } });
	await content(page).locator("p").filter({ hasText: SECOND }).selectText();
	let bubble = page.getByRole("toolbar", { name: "Text formatting" });
	await expect(bubble).toBeVisible();
	await expect(bubble.getByRole("button", { name: "Bold" })).toBeVisible();
	await expect(bubble.getByRole("button", { name: "Comment on this passage" })).toBeVisible();
	await expect(page.getByRole("toolbar", { name: "Selection actions" })).toHaveCount(0);
});

test("a long phone thread opens at the medium detent, drags up to large and down to dismiss", async ({ join, seed }) => {
	let notes = Array.from(
		{ length: 4 },
		(_, index) =>
			`Note ${index + 1}. ${"A long note that wraps over several lines on a phone. ".repeat(8)}`,
	);
	await seed(SOURCE, { threads: [await open("review the pilot", notes)] });
	let page = await join("ana", IPHONE);
	let marker = page.getByRole("button", { name: /^Comment on “review the pilot”/ });
	await marker.tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await settled(sheet);

	// Half the screen shows; the reply composer stays on its visible edge.
	let medium = await size(sheet);
	expect(Math.abs(medium.y - 844 / 2)).toBeLessThanOrEqual(2);
	await expect(sheet).not.toHaveAttribute("data-expanded");
	let reply = sheet.getByRole("textbox", { name: "Reply", exact: true });
	await expectInsideViewport(reply);
	expect((await size(sheet.getByRole("button", { name: "Send reply" }))).height)
		.toBeGreaterThanOrEqual(44);

	// The grabber row pulls it up to the large detent, where the backdrop deepens.
	let backdrop = page.locator("[data-plan-comment-sheet-backdrop]");
	let dim = () => backdrop.evaluate(element => Number(getComputedStyle(element).opacity));
	let mediumDim = await dim();
	await drag(page, { x: 195, y: medium.y + 10 }, -300);
	await expect(sheet).toHaveAttribute("data-expanded");
	await settled(sheet);
	let large = await size(sheet);
	expect(large.y).toBeLessThan(medium.y - 100);
	expect(large.y).toBeGreaterThanOrEqual(844 * (1 - 0.92) - 1);
	await expectInsideViewport(reply);
	await expect.poll(dim).toBeGreaterThan(mediumDim);

	// A downward flick dismisses it and hands focus back to the marker.
	await drag(page, { x: 195, y: large.y + 10 }, 600);
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
});

test("a phone thread sheet steps through the document's threads and stops at its ends", async ({ join, seed }) => {
	await seed(SOURCE, {
		threads: [
			await open("starting with the docs team", ["Which team is next?"], 0),
			await open("review the pilot", ["Is two weeks enough?"], 1),
		],
	});
	let page = await join("ana", IPHONE);
	await page.getByRole("button", { name: /^Comment on “starting with the docs team”/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await expect(sheet.getByText("1 of 2", { exact: true })).toBeVisible();
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText(
		"starting with the docs team",
	);
	await expect(sheet.getByRole("button", { name: "Previous comment" })).toBeDisabled();
	let next = sheet.getByRole("button", { name: "Next comment" });
	expect((await size(next)).height).toBeGreaterThanOrEqual(44);
	await next.click();
	await expect(sheet.getByText("2 of 2", { exact: true })).toBeVisible();
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText("review the pilot");
	await expect(sheet).toContainText("Is two weeks enough?");
	await expect(sheet.getByRole("button", { name: "Next comment" })).toBeDisabled();
	// The thread paged away from leaves no preview card over the document.
	await expect(page.locator(".plan-comment-preview")).toHaveCount(0);

	// Closing returns to the thread now shown, not the one the sheet opened with.
	await sheet.getByRole("button", { name: "Close comment" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Comment on “review the pilot”/ })).toBeFocused();
	// Focus coming back on touch does not raise a hover preview.
	await expect(page.locator(".plan-comment-preview")).toHaveCount(0);
});

test("paging between short and long threads keeps the medium detent and its backdrop", async ({ join, seed }) => {
	let long = Array.from(
		{ length: 4 },
		(_, index) =>
			`Note ${index + 1}. ${"A long note that wraps over several lines on a phone. ".repeat(8)}`,
	);
	await seed(SOURCE, {
		threads: [
			await open("starting with the docs team", ["Which team is next?"], 0),
			await open("review the pilot", long, 1),
		],
	});
	let page = await join("ana", IPHONE);
	let backdrop = page.locator("[data-plan-comment-sheet-backdrop]");
	let dim = () => backdrop.evaluate(element => Number(getComputedStyle(element).opacity));
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await page.getByRole("button", { name: /^Comment on “starting with the docs team”/ }).tap();
	await settled(sheet);
	let resting = await dim();
	expect(resting).toBeGreaterThan(0.1);

	// A tap on the short sheet's header must not count as a pull to the large detent.
	await sheet.getByRole("button", { name: "Next comment" }).tap();
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText("review the pilot");
	await settled(sheet);
	await expect(sheet).not.toHaveAttribute("data-expanded");
	await expect.poll(async () => Math.abs((await size(sheet)).y - 844 / 2)).toBeLessThanOrEqual(2);
	let passage = page.locator(".plan-content > p").filter({ hasText: SECOND });
	await expect.poll(async () => {
		let box = await size(passage);
		return box.y + 10 <= (await size(sheet)).y;
	}).toBe(true);
	await expect.poll(dim).toBeCloseTo(resting, 2);

	// Pulled up to large, then paged back: the next thread opens at medium again, and the
	// backdrop returns to its resting depth rather than vanishing.
	await drag(page, { x: 195, y: (await size(sheet)).y + 10 }, -300);
	await expect(sheet).toHaveAttribute("data-expanded");
	await expect.poll(dim).toBeGreaterThan(resting);
	await sheet.getByRole("button", { name: "Previous comment" }).tap();
	await expect(sheet.locator("[data-plan-comment-sheet-quote]")).toHaveText(
		"starting with the docs team",
	);
	await expect(sheet).not.toHaveAttribute("data-expanded");
	await expect.poll(dim).toBeCloseTo(resting, 2);
});

test("a selection low on a phone screen scrolls clear of the docked bar", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", IPHONE);
	let passage = content(page).locator("p").filter({ hasText: "Padding paragraph." }).nth(20);
	// Put the passage on the last lines above the tab bar, where the selection bar will dock.
	let tabs = await size(page.getByRole("navigation", { name: "Workspace view" }));
	await passage.evaluate((element, dock) => {
		let scroller = element.closest("[data-plan-scroll]")!;
		scroller.scrollTop += element.getBoundingClientRect().bottom - (dock - 12);
	}, tabs.y);
	expect((await size(passage)).y).toBeGreaterThan(tabs.y - 80);
	await passage.selectText();
	let bar = page.getByRole("toolbar", { name: "Selection actions" });
	await expect(bar).toBeVisible();
	await bar.evaluate(element => Promise.all(element.getAnimations().map(item => item.finished)));
	await expect.poll(async () => {
		let selection = await page.evaluate(() =>
			getSelection()!.getRangeAt(0).getBoundingClientRect().bottom
		);
		return selection <= (await size(bar)).y;
	}).toBe(true);
});

test("the docked bar stands on the keyboard", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let emulation = await phone(browser, baseURL!, room);
	try {
		let { page } = emulation;
		await content(page).locator("p").filter({ hasText: FIRST }).selectText();
		let bar = page.getByRole("toolbar", { name: "Selection actions" });
		await expect(bar).toBeVisible();
		await setVisualViewport(page, { event: "resize", height: 506, offsetTop: 0 });
		await expect.poll(async () => {
			let box = await size(bar);
			return box.y + box.height <= 506 && box.y + box.height > 506 - 48;
		}).toBe(true);
	} finally {
		await emulation.close();
	}
});

test("a phone marker reaches 44px into the empty margin without covering the next line", async ({ join, seed }) => {
	await seed(SOURCE, { threads: [await open("review the pilot", ["Is two weeks enough?"])] });
	let page = await join("ana", IPHONE);
	let marker = page.getByRole("button", { name: /^Comment on “review the pilot”/ });
	let chip = await size(marker.locator(".plan-comment-chip"));
	let paragraph = await size(page.locator(".plan-content > p").filter({ hasText: SECOND }));
	let hits = await page.evaluate(({ chip, paragraph }) => {
		let middle = chip.y + chip.height / 2;
		let gutter = Math.max(chip.x + chip.width / 2, paragraph.x + paragraph.width + 2);
		return [
			[gutter, middle - 20],
			[gutter, middle + 20],
			// The end of the second line still takes the tap as text.
			[paragraph.x + paragraph.width - 2, middle + 24],
		].map(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest("[data-plan-comment-button]"));
	}, { chip, paragraph });
	expect(hits).toEqual([true, true, false]);
});
