/**
 * The Planner's queue above the composer, through the real server, sockets and storage, against the
 * isolated `AGENT=on` fake-harness project. `SLOW-LIVE` keeps a turn running for several seconds, so
 * what is typed meanwhile waits.
 */
import AxeBuilder from "@axe-core/playwright";

import { chatInput } from "./chat-input";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, content, expect, openIsolatedRoom, roomPath, test } from "./room";

import type { Browser, Locator, Page } from "@playwright/test";

const SOURCE = "# Queue\nThe harp needs new strings.\n\nThe bridge needs a new saddle.\n";
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const TURN = 30_000;

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function queueOf(page: Page) {
	return chatPane(page).getByRole("region", { name: "Waiting for Chopin" });
}

function rowsOf(page: Page) {
	return queueOf(page).locator("[data-chat-queue-item]");
}

function transcriptHas(page: Page, text: string): Locator {
	return chatPane(page).locator("[data-chat-entry]").filter({ hasText: text });
}

async function say(page: Page, text: string) {
	let chat = chatPane(page);
	await chatInput(chat).fill(text);
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect(chatInput(chat)).toHaveText("");
}

async function commentToChopin(page: Page, passage: string, text: string) {
	await content(page).locator("p", { hasText: passage }).first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let card = page.getByRole("dialog", { name: "New comment" });
	await card.getByRole("checkbox", { name: "Send to Chopin" }).check();
	await card.getByRole("textbox", { name: "Comment" }).fill(text);
	await card.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(card).toHaveCount(0);
}

type Words = { first: string; reply: string; second: string };
type Order = { gaps: number[]; below: boolean[] };

/**
 * Samples, in the page, after every change to it and every frame, where the first request's group
 * and the reply to it are, and whether the second request is drawn below the reply: what a reader
 * looking at the reply would see move. A reply is on screen for moments before the next turn begins,
 * so a sample per frame alone could miss the change.
 */
async function watchOrder(page: Page, words: Words) {
	await page.evaluate(words => {
		let order: Order = { gaps: [], below: [] };
		(window as unknown as { order: Order }).order = order;
		let sample = () => {
			let scroll = document.querySelector("[data-chat-scroll]");
			if (!scroll) return;
			let find = (text: string) => {
				let walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					if (node.textContent?.includes(text)) return node.parentElement!;
				}
			};
			let [first, reply, second] = [words.first, words.reply, words.second].map(find);
			if (first && reply) {
				let [above, below] = [first, reply].map(element =>
					element.closest("[data-chat-entry]")!.getBoundingClientRect().top
				);
				order.gaps.push(below! - above!);
			}
			if (reply && second) {
				order.below.push(second.getBoundingClientRect().top > reply.getBoundingClientRect().top);
			}
		};
		new MutationObserver(sample).observe(document.body, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		let frame = () => {
			sample();
			requestAnimationFrame(frame);
		};
		frame();
	}, words);
}

async function orderSeen(page: Page): Promise<Order> {
	return page.evaluate(() => (window as unknown as { order: Order }).order);
}

/** The first request, the reply to it, the second request and the reply to that, top to bottom. */
async function wordsInOrder(page: Page, words: string[]): Promise<number[]> {
	return page.evaluate(words => {
		let walker = document.createTreeWalker(
			document.querySelector("[data-chat-scroll]")!,
			NodeFilter.SHOW_TEXT,
		);
		let tops = words.map(() => -1);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let at = words.findIndex(word => node!.textContent?.includes(word));
			if (at >= 0 && tops[at] < 0) {
				let range = document.createRange();
				range.selectNodeContents(node);
				tops[at] = range.getBoundingClientRect().top;
			}
		}
		return tops;
	}, words);
}

/**
 * Which edges of the queue's list say there are rows beyond them, how far the page fades each (read
 * from the mask it draws), and whether a row is cut by an edge.
 */
async function edgesOf(list: Locator) {
	return list.evaluate(element => {
		let mask = getComputedStyle(element).maskImage;
		let box = element.getBoundingClientRect();
		return {
			above: element.hasAttribute("data-beyond-above"),
			below: element.hasAttribute("data-beyond-below"),
			// A fade of none is drawn as no stop at all: from the top it is 0px, and from the bottom 100%.
			fadeAbove: Number(/rgb\(0, 0, 0\) ([\d.]+)px/.exec(mask)?.[1] ?? 0),
			fadeBelow: Number(/calc\(100% - ([\d.]+)px\)/.exec(mask)?.[1] ?? 0),
			cutAbove: [...element.children].some(row => {
				let rect = row.getBoundingClientRect();
				return rect.top < box.top && rect.bottom > box.top;
			}),
			cutBelow: [...element.children].some(row => {
				let rect = row.getBoundingClientRect();
				return rect.top < box.bottom && rect.bottom > box.bottom;
			}),
		};
	});
}

/**
 * What a pointer finds where the Delete menu's button is: whether the button itself is the hit
 * target there ("live"), and how drawn its anchor is. Nothing invisible may be live.
 */
async function reachOf(row: Locator) {
	return row.getByRole("button", { name: "Message actions" }).evaluate(button => {
		let box = button.getBoundingClientRect();
		let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		return {
			live: !!hit && button.contains(hit),
			opacity: getComputedStyle(button.closest(".chat-message-menu-anchor")!).opacity,
		};
	});
}

const ALSO_CANCELS = "Also cancels this waiting message.";

async function startBusyTurn(page: Page, text = "@chopin SLOW-LIVE write up the approach") {
	await say(page, text);
	await expect(chatPane(page).getByRole("button", { name: "Stop Chopin" })).toBeVisible();
}

test("typing while the Planner is busy fills a queue above the composer, in order, and keeps it out of the transcript", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await expect(queueOf(page)).toHaveCount(0);

	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	await say(page, "@chopin third: add a rollout paragraph");

	let queue = queueOf(page);
	await expect(queue).toContainText("2 waiting for Chopin");
	let rows = rowsOf(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("Ana");
	await expect(rows.nth(0)).toContainText("second: list the failure modes");
	await expect(rows.nth(1)).toContainText("third: add a rollout paragraph");
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);
	await expect(transcriptHas(page, "third: add a rollout paragraph")).toHaveCount(0);

	let [queueBox, composerBox] = await Promise.all([
		queue.boundingBox(),
		chatPane(page).locator(".chat-composer").boundingBox(),
	]);
	expect(queueBox!.y + queueBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);

	let found = await new AxeBuilder({ page }).include("[data-chat-queue]").analyze();
	expect(found.violations).toEqual([]);
});

test("the author cancels a waiting message from the keyboard, focus moves on, and what is left starts in order", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	await say(page, "@chopin third: add a rollout paragraph");
	let rows = rowsOf(page);
	await expect(rows).toHaveCount(2);

	let cancel = rows.nth(0).getByRole("button", { name: "Cancel message from Ana" });
	await cancel.focus();
	await page.keyboard.press("Enter");

	await expect(rows).toHaveCount(1);
	await expect(queueOf(page)).toContainText("1 waiting for Chopin");
	await expect(rows.first()).toContainText("third: add a rollout paragraph");
	await expect(rows.first().getByRole("button", { name: "Edit message from Ana" })).toBeFocused();
	await expect(queueOf(page).getByRole("status")).toHaveText("Cancelled the message from Ana.");

	await expect(transcriptHas(page, "third: add a rollout paragraph")).toHaveCount(1, {
		timeout: TURN,
	});
	await expect(queueOf(page)).toHaveCount(0);
	await expect(chatPane(page).getByText("Latest pull request:").last()).toBeVisible({
		timeout: TURN,
	});
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);

	await page.reload();
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);
	await expect(transcriptHas(page, "third: add a rollout paragraph")).toHaveCount(1);
});

test("the author edits a waiting message by keyboard, and its turn reads the edit", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	let row = rowsOf(page).first();
	await expect(row).toContainText("second: list the failure modes");

	await row.getByRole("button", { name: "Edit message from Ana" }).press("Enter");
	let field = row.getByRole("textbox", { name: "Edit message" });
	await expect(field).toBeFocused();
	await expect(field).toHaveValue("second: list the failure modes");
	let save = row.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();

	await page.keyboard.type(" and the rollback plan");
	await page.keyboard.press("Escape");
	await expect(row.getByRole("textbox")).toHaveCount(0);
	await expect(row).toContainText("second: list the failure modes");
	await expect(row).not.toContainText("rollback plan");
	await expect(row.getByRole("button", { name: "Edit message from Ana" })).toBeFocused();

	await row.getByRole("button", { name: "Edit message from Ana" }).press("Enter");
	await field.fill("second: list the failure modes and the rollback plan");
	await expect(save).toBeEnabled();
	await field.press("Enter");
	await expect(row.getByRole("textbox")).toHaveCount(0);
	await expect(row).toContainText("second: list the failure modes and the rollback plan");
	await expect(row.getByRole("button", { name: "Edit message from Ana" })).toBeFocused();
	await expect(queueOf(page)).toContainText("1 waiting for Chopin");

	await expect(transcriptHas(page, "and the rollback plan")).toHaveCount(1, { timeout: TURN });
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(1);
	await page.reload();
	await expect(transcriptHas(page, "second: list the failure modes and the rollback plan"))
		.toHaveCount(1);
});

test("a saved edit shows its acknowledged text before the queue broadcast arrives", async ({ baseURL, page, room, seed }) => {
	await seed(SOURCE);
	let holding = false;
	let held: Array<() => void> = [];
	await authenticate(page, "ana", baseURL!);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (holding && typeof message === "string" && JSON.parse(message).kind === "chat:queue") {
				held.push(() => route.send(message));
				return;
			}
			route.send(message);
		});
	});
	await page.goto(roomPath(room));
	await expect(chatInput(chatPane(page))).toBeVisible();
	await startBusyTurn(page);
	await say(page, "@chopin original text");
	let row = rowsOf(page).first();
	await expect(row).toContainText("original text");
	await row.getByRole("button", { name: "Edit message from Ana" }).click();
	await row.getByRole("textbox", { name: "Edit message" }).fill("revised text");
	holding = true;
	await row.getByRole("button", { name: "Save", exact: true }).click();
	await expect(row.getByRole("textbox")).toHaveCount(0);
	await expect(row).toContainText("revised text", { timeout: 2_000 });
	holding = false;
	for (let send of held) send();
});

test("a second person sees the same queue live, and can change none of it", async ({ join, seed }) => {
	await seed(SOURCE);
	let ana = await join("ana");
	let bob = await join("bob");
	await startBusyTurn(ana);
	await say(ana, "@chopin second: list the failure modes");
	await say(ana, "@chopin third: add a rollout paragraph");

	await expect(queueOf(bob)).toContainText("2 waiting for Chopin");
	await expect(rowsOf(bob).nth(0)).toContainText("Ana");
	await expect(rowsOf(bob).nth(0)).toContainText("second: list the failure modes");
	await expect(rowsOf(bob).nth(1)).toContainText("third: add a rollout paragraph");
	await expect(queueOf(bob).getByRole("button")).toHaveCount(0);
	await expect(rowsOf(ana).getByRole("button")).toHaveCount(6);
	await expect(rowsOf(ana).getByRole("button", { name: "Edit message from Ana" })).toHaveCount(2);
	await expect(rowsOf(ana).getByRole("button", { name: "Cancel message from Ana" })).toHaveCount(2);
	await expect(rowsOf(ana).getByRole("button", { name: "Message actions" })).toHaveCount(2);

	await say(bob, "@chopin bob's question about the saddle");
	await expect(rowsOf(ana)).toHaveCount(3);
	await expect(rowsOf(ana).nth(2)).toContainText("Bob");
	await expect(rowsOf(ana).nth(2).getByRole("button")).toHaveCount(0);
	await expect(rowsOf(bob).nth(2).getByRole("button", { name: "Cancel message from Bob" }))
		.toBeVisible();
	await expect(rowsOf(bob).filter({ hasText: "Ana" }).getByRole("button")).toHaveCount(0);

	await rowsOf(ana).nth(0).getByRole("button", { name: "Cancel message from Ana" }).click();
	await expect(queueOf(bob)).toContainText("2 waiting for Chopin");
	await expect(rowsOf(bob).nth(0)).toContainText("third: add a rollout paragraph");

	await rowsOf(ana).nth(0).getByRole("button", { name: "Edit message from Ana" }).click();
	await rowsOf(ana).nth(0).getByRole("textbox", { name: "Edit message" })
		.fill("third: add a short rollout paragraph");
	await rowsOf(ana).nth(0).getByRole("button", { name: "Save", exact: true }).click();
	await expect(rowsOf(bob).nth(0)).toContainText("third: add a short rollout paragraph");
});

test("cancelling hands focus past read-only rows and then back to the composer", async ({ join, seed }) => {
	await seed(SOURCE);
	let ana = await join("ana");
	let bob = await join("bob");
	await startBusyTurn(ana);
	await say(ana, "@chopin first from Ana");
	await say(bob, "@chopin from Bob");
	await say(ana, "@chopin last from Ana");
	let rows = rowsOf(ana);
	await expect(rows).toHaveCount(3);
	await rows.nth(0).getByRole("button", { name: "Cancel message from Ana" }).press("Enter");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(1).getByRole("button", { name: "Edit message from Ana" })).toBeFocused();
	await rows.nth(1).getByRole("button", { name: "Cancel message from Ana" }).press("Enter");
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("Bob");
	await expect(chatInput(chatPane(ana))).toBeFocused();
});

test("a message leaves the queue and joins the transcript as one move, and the composer never shifts", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await startBusyTurn(page, "@chopin SLOW-LIVE write up the approach");
	await say(page, "@chopin second: list the failure modes");
	await expect(rowsOf(page)).toHaveCount(1);

	await page.evaluate(() => {
		let probe: { places: string; composers: number[] } = { places: "", composers: [] };
		(window as unknown as { probe: typeof probe }).probe = probe;
		let sample = () => {
			let text = "second: list the failure modes";
			let queued = [...document.querySelectorAll("[data-chat-queue-item]")]
				.some(row => row.textContent?.includes(text));
			let said = [...document.querySelectorAll("[data-chat-entry]")]
				.some(entry => entry.textContent?.includes(text));
			let place = queued && said ? "b" : queued ? "q" : said ? "t" : "n";
			if (probe.places.at(-1) !== place) probe.places += place;
			probe.composers.push(document.querySelector(".chat-composer")!.getBoundingClientRect().top);
			requestAnimationFrame(sample);
		};
		sample();
	});

	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(1, {
		timeout: TURN,
	});
	await expect(queueOf(page)).toHaveCount(0);
	let probe = await page.evaluate(() =>
		(window as unknown as { probe: { places: string; composers: number[] } }).probe
	);
	expect(probe.places).toBe("qt");
	expect(Math.max(...probe.composers) - Math.min(...probe.composers)).toBeLessThanOrEqual(1);
});

const FIRST = "SLOW-LIVE write up the approach";
const SECOND = "second: list the failure modes";
const WORDS = { first: FIRST, reply: "Streaming", second: SECOND };
const REPLIES = [FIRST, "Streaming", SECOND, "Latest pull request:"];

function expectInOrder(tops: number[]) {
	expect(tops.every(top => top >= 0)).toBe(true);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
}

/**
 * The second request was never drawn above the reply, and all is in order. With `still`, the reply
 * also stayed exactly where it was against the first request.
 */
async function expectUnmoved(page: Page, still = true) {
	let order = await orderSeen(page);
	if (still) {
		expect(order.gaps.length).toBeGreaterThan(0);
		expect(Math.max(...order.gaps) - Math.min(...order.gaps)).toBeLessThanOrEqual(1);
	}
	expect(order.below.length).toBeGreaterThan(0);
	expect(order.below.every(Boolean)).toBe(true);
	expectInOrder(await wordsInOrder(page, REPLIES));
}

test("a message that waited joins the transcript after the reply that was on screen, for everyone, and that reply never moves", async ({ join, seed }) => {
	await seed(SOURCE);
	let ana = await join("ana");
	let bob = await join("bob");
	await startBusyTurn(ana, `@chopin ${FIRST}`);
	await say(ana, `@chopin ${SECOND}`);
	await expect(rowsOf(bob)).toHaveCount(1);

	// Both watch from before the reply appears, which is when the first turn ends.
	let pages = [ana, bob];
	await Promise.all(pages.map(page => watchOrder(page, WORDS)));
	for (let page of pages) {
		await expect(transcriptHas(page, SECOND)).toHaveCount(1, { timeout: TURN });
		await expect(queueOf(page)).toHaveCount(0);
		await expect(chatPane(page).getByText("Latest pull request:").last()).toBeVisible({
			timeout: TURN,
		});
	}

	for (let page of pages) await expectUnmoved(page);

	// Saved in that order: a reload draws it again.
	await ana.reload();
	await expect(transcriptHas(ana, "Latest pull request:").last()).toBeVisible();
	expectInOrder(await wordsInOrder(ana, REPLIES));
});

test("a browser that reconnects while a message waits draws the same order when its turn starts", async ({ baseURL, page, room, seed }) => {
	await seed(SOURCE);
	let sockets: Array<{ close: () => Promise<void> }> = [];
	await authenticate(page, "ana", baseURL!);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
		sockets.push({
			close: async () => {
				await route.close();
				await server.close();
			},
		});
	});
	await page.goto(roomPath(room));
	await expect(chatInput(chatPane(page))).toBeVisible();
	await startBusyTurn(page, `@chopin ${FIRST}`);
	await say(page, `@chopin ${SECOND}`);
	await expect(rowsOf(page)).toHaveCount(1);

	let connections = sockets.length;
	await sockets.at(-1)!.close();
	await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(connections);
	// The transcript the new connection is told still keeps the message out until its turn starts.
	await expect(rowsOf(page)).toHaveCount(1);
	await expect(transcriptHas(page, SECOND)).toHaveCount(0);
	await watchOrder(page, WORDS);

	await expect(transcriptHas(page, SECOND)).toHaveCount(1, { timeout: TURN });
	await expect(chatPane(page).getByText("Latest pull request:").last()).toBeVisible({
		timeout: TURN,
	});
	// A connection made again redraws the first request's group when the first turn ends, whatever
	// is queued behind it, so what is held to here is only that the second is drawn after the reply.
	await expectUnmoved(page, false);
});

test("an edit that loses the race with its turn starting says so plainly, and the message goes as it was written", async ({ join, page, seed }) => {
	await seed(SOURCE);
	let held: string[] = [];
	let hold = true;
	let toServer: ((message: string) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		toServer = message => server.send(message);
		route.onMessage(message => {
			if (hold && typeof message === "string" && JSON.parse(message).kind === "chat:edit") {
				held.push(message);
				return;
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	await join("ana");
	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	let row = rowsOf(page).first();
	await row.getByRole("button", { name: "Edit message from Ana" }).click();
	await row.getByRole("textbox", { name: "Edit message" }).fill("second: something else entirely");
	await row.getByRole("textbox", { name: "Edit message" }).press("Enter");
	await expect.poll(() => held.length).toBe(1);

	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(1, {
		timeout: TURN,
	});
	hold = false;
	toServer!(held[0]!);
	let notice = queueOf(page).locator("[data-chat-queue-notice]");
	await expect(notice).toHaveText("Chopin already started on it, so it can't be changed.");
	await expect(transcriptHas(page, "something else entirely")).toHaveCount(0);
	await expect(notice).toHaveCount(0, { timeout: 15_000 });
});

test("cancelling an edited message from another tab does not say it started", async ({ join, seed }) => {
	await seed(SOURCE);
	let first = await join("ana");
	let second = await join("ana");
	await startBusyTurn(first);
	await say(first, "@chopin a message to take back");
	await expect(rowsOf(second)).toHaveCount(1);
	await rowsOf(first).first().getByRole("button", { name: "Edit message from Ana" }).click();
	await expect(rowsOf(first).first().getByRole("textbox", { name: "Edit message" })).toBeVisible();
	await rowsOf(second).first().getByRole("button", { name: "Cancel message from Ana" }).click();
	await expect(queueOf(first)).toHaveCount(0, { timeout: 3_000 });
	await expect(first.getByText("Chopin already started on it, so it can't be changed."))
		.toHaveCount(0);
});

test("a long message keeps to one line, and all waiting messages stay in an ordered, bounded list", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await startBusyTurn(page);
	let long =
		"When the sidebar is narrow, can the state labels fold into glyphs before the title truncates, "
		+ "and does the same hold on a phone, in landscape, and with the keyboard open?";
	await say(page, `@chopin ${long}`);
	let text = rowsOf(page).first().locator("[data-chat-queue-text]");
	await expect(text).toHaveText(long);
	await expect(text).toHaveAttribute("title", long);
	let [overflow, height] = await text.evaluate(element => [
		element.scrollWidth - element.clientWidth,
		element.getBoundingClientRect().height,
	]);
	expect(overflow).toBeGreaterThan(0);
	expect(height).toBeLessThan(30);

	for (let number of [2, 3, 4, 5]) await say(page, `@chopin message ${number}`);
	await expect(queueOf(page)).toContainText("5 waiting for Chopin");
	await expect(rowsOf(page)).toHaveCount(5);
	await expect(rowsOf(page).locator("[data-chat-queue-text]")).toHaveText([
		long,
		"message 2",
		"message 3",
		"message 4",
		"message 5",
	]);
	let list = queueOf(page).getByRole("list");
	let dimensions = await list.evaluate(element => ({
		height: element.clientHeight,
		scrollHeight: element.scrollHeight,
		overflow: getComputedStyle(element).overflowY,
	}));
	expect(dimensions.overflow).toBe("auto");
	expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
	await expect.poll(() =>
		list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
	).toBeLessThanOrEqual(1);
	let [lastBox, listBox] = await Promise.all([
		rowsOf(page).last().boundingBox(),
		list.boundingBox(),
	]);
	expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1);
	// At the end, the rows above fade out at the top edge, and nothing fades at the bottom.
	await expect.poll(() => edgesOf(list)).toMatchObject({
		above: true,
		below: false,
		fadeAbove: 24,
		fadeBelow: 0,
	});

	await list.evaluate(element => element.scrollTop = 0);
	await expect.poll(() => edgesOf(list)).toMatchObject({
		above: false,
		below: true,
		fadeAbove: 0,
		fadeBelow: 24,
	});
	await page.evaluate(() => new Promise(requestAnimationFrame));
	await say(page, "@chopin message 6");
	await expect(rowsOf(page)).toHaveCount(6);
	await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
});

test("a comment sent to Chopin waits as a reply to a comment, which nobody can change", async ({ join, seed }) => {
	await seed(SOURCE);
	let ana = await join("ana");
	let bob = await join("bob");
	await startBusyTurn(ana);
	await say(ana, "@chopin SLOW-LIVE and then this one");
	await say(ana, "@chopin SLOW-LIVE and then that one");
	await commentToChopin(ana, "The bridge needs a new saddle.", "Is the saddle right?");

	for (let page of [ana, bob]) {
		let row = rowsOf(page).filter({ hasText: "Reply to a comment" });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText("Ana");
		await expect(row.getByRole("button")).toHaveCount(0);
		await expect(row).not.toContainText("saddle");
	}
	await expect(rowsOf(ana).filter({ hasText: "and then that one" }).getByRole("button"))
		.toHaveCount(3);
	await expect(rowsOf(bob).getByRole("button")).toHaveCount(0);
});

async function wireOf(browser: Browser, baseURL: string, room: string, handle: string) {
	let replies: Array<{ rid?: string; kind: string; message?: string; code?: string }> = [];
	let toServer: ((message: string) => void) | undefined;
	let context = await browser.newContext({ baseURL });
	let page = await context.newPage();
	await authenticate(page, handle, baseURL);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		toServer = message => server.send(message);
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") replies.push(JSON.parse(message));
			route.send(message);
		});
	});
	await page.goto(roomPath(room));
	return {
		close: () => context.close(),
		page,
		async ask(frame: Record<string, unknown>) {
			let rid = crypto.randomUUID();
			toServer!(JSON.stringify({ ...frame, rid, ts: 0 }));
			await expect.poll(() => replies.some(reply => reply.rid === rid)).toBe(true);
			return replies.find(reply => reply.rid === rid)!;
		},
	};
}

test("only the author may change a waiting message, whatever any browser sends: a reader is refused for want of write access, a writer for not being the author", async ({ baseURL, browser, join, room, seed }) => {
	await seed(SOURCE);
	let reader = await wireOf(browser, baseURL!, room, "readonly");
	let writer = await wireOf(browser, baseURL!, room, "bob");
	let ana = await join("ana");
	await startBusyTurn(ana);
	await say(ana, "@chopin second: list the failure modes");
	let row = rowsOf(ana).first();
	await expect(row).toContainText("second: list the failure modes");
	let id = (await row.getAttribute("data-queue-id"))!;
	await expect(rowsOf(reader.page).first()).toContainText("second: list the failure modes");
	await expect(rowsOf(writer.page).first()).toContainText("second: list the failure modes");
	await expect(queueOf(reader.page).getByRole("button")).toHaveCount(0);

	let edit = { kind: "chat:edit", id, text: "rewritten by somebody else" };
	let cancel = { kind: "chat:unqueue", id };
	for (let frame of [edit, cancel]) {
		expect(await reader.ask(frame)).toMatchObject({
			kind: "session:error",
			message: "repository write access is required",
		});
		let refused = await writer.ask(frame);
		expect(refused).toMatchObject({
			kind: "session:error",
			message: "only the author of a queued message can change it",
		});
		expect(refused.code).toBeUndefined();
	}
	await expect(row).toContainText("second: list the failure modes");
	await expect(row).not.toContainText("rewritten by somebody else");
	await expect(rowsOf(reader.page)).toHaveCount(1);
	await reader.close();
	await writer.close();
});

test("a queue is visible and reachable throughout its entrance on a phone", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE);
	try {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await startBusyTurn(page);
		await page.evaluate(() => {
			let frames: Array<{ above: boolean; visible: boolean; reachable: boolean }> = [];
			(window as unknown as { queueEntrance: typeof frames }).queueEntrance = frames;
			let sample = () => {
				let queue = document.querySelector<HTMLElement>("[data-chat-queue]");
				let composer = document.querySelector<HTMLElement>(".chat-composer");
				let buttons = queue?.querySelectorAll<HTMLButtonElement>(
					'.chat-queue-actions button[aria-label^="Edit message"], '
						+ '.chat-queue-actions button[aria-label^="Cancel message"]',
				);
				if (queue && composer && buttons?.length === 2) {
					let box = queue.getBoundingClientRect();
					let visible =
						getComputedStyle(queue.closest(".motion-collapse-content")!).opacity === "1";
					let reachable = [...buttons].every(button => {
						let rect = button.getBoundingClientRect();
						return [-21, 21].every(offset =>
							button.contains(document.elementFromPoint(
								rect.left + rect.width / 2,
								rect.top + rect.height / 2 + offset,
							))
						);
					});
					frames.push({
						above: box.bottom <= composer.getBoundingClientRect().top + 1,
						visible,
						reachable,
					});
				}
				if (frames.length < 20) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		await say(page, "@chopin second: list the failure modes");
		await expect.poll(() =>
			page.evaluate(() => (window as unknown as { queueEntrance: unknown[] }).queueEntrance.length)
		).toBe(20);
		let frames = await page.evaluate(() =>
			(window as unknown as {
				queueEntrance: Array<{ above: boolean; visible: boolean; reachable: boolean }>;
			}).queueEntrance
		);
		expect(frames.filter(frame => !frame.above || !frame.visible || !frame.reachable)).toEqual([]);
	} finally {
		await close();
	}
});

test("beside Cancel the Delete menu is always drawn, so nothing invisible can be pressed, and says it also cancels the waiting message", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	let row = rowsOf(page).first();
	let cancel = row.getByRole("button", { name: "Cancel message from Ana" });
	let actions = row.getByRole("button", { name: "Message actions" });
	await expect(cancel).toBeVisible();
	await expect(actions).toHaveCount(1);

	await page.mouse.move(0, 0);
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });

	await row.hover();
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
	let box = (await actions.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });

	await page.mouse.move(0, 0);
	await cancel.focus();
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
	await page.keyboard.press("Tab");
	await expect(actions).toBeFocused();
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
	let [ring, edge] = await actions.evaluate(button => {
		let styles = getComputedStyle(button);
		return [
			button.getBoundingClientRect().right + parseFloat(styles.outlineOffset)
			+ parseFloat(styles.outlineWidth),
			button.closest("ol")!.getBoundingClientRect().right,
		];
	});
	expect(ring).toBeLessThanOrEqual(edge!);

	await page.keyboard.press("Enter");
	let item = page.getByRole("menuitem", { name: "Delete", exact: true });
	await expect(item).toBeVisible();
	await expect(item).toHaveAccessibleName("Delete");
	await expect(item).toHaveAccessibleDescription(ALSO_CANCELS);
	await expect(page.getByRole("menu", { name: "Message actions" })).toContainText(ALSO_CANCELS);
	let menuFound = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
	expect(menuFound.violations).toEqual([]);
	// The description's text is aria-hidden and only referenced, so read it from Chromium's own tree.
	let tree = await page.context().newCDPSession(page);
	let { nodes } = await tree.send("Accessibility.getFullAXTree");
	let delete_ = nodes.find(node =>
		node.role?.value === "menuitem" && node.name?.value === "Delete"
	);
	expect(delete_?.description?.value).toBe(ALSO_CANCELS);
	expect(nodes.some(node => node.name?.value === ALSO_CANCELS && !node.ignored)).toBe(false);
	await page.keyboard.press("Escape");
	await expect(actions).toBeFocused();

	await actions.evaluate(button => button.blur());
	await page.mouse.move(0, 0);
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
});

test("on a phone the Delete menu is drawn where a finger can press it, says it also cancels the waiting message, and takes the message back", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE);
	try {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await startBusyTurn(page);
		await say(page, "@chopin second: list the failure modes");
		await say(page, "@chopin third: add a rollout paragraph");
		await expect(rowsOf(page)).toHaveCount(2);

		let row = rowsOf(page).first();
		expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
		await expectInsideViewport(row.getByRole("button", { name: "Message actions" }));
		await row.getByRole("button", { name: "Message actions" }).tap();
		let item = page.getByRole("menuitem", { name: "Delete", exact: true });
		await expect(item).toHaveAccessibleDescription(ALSO_CANCELS);
		await expect(page.getByRole("menu", { name: "Message actions" })).toContainText(ALSO_CANCELS);
		let menu = (await page.getByRole("menu", { name: "Message actions" }).boundingBox())!;
		let viewport = page.viewportSize()!;
		expect(menu.x).toBeGreaterThanOrEqual(0);
		expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
		expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
		let found = await new AxeBuilder({ page }).include("[data-chat-queue]").include('[role="menu"]')
			.analyze();
		expect(found.violations).toEqual([]);

		await item.tap();
		await expect(rowsOf(page)).toHaveCount(1);
		await expect(rowsOf(page).first()).toContainText("third: add a rollout paragraph");
		await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);
	} finally {
		await close();
	}
});

test("while the page is offline Cancel is not offered, the Delete menu is the one way and says nothing of it, and the message is dropped when the connection is back", async ({ baseURL, page, room, seed }) => {
	test.setTimeout(90_000);
	await seed(SOURCE);
	let offline = false;
	let sockets: Array<{ close: () => Promise<void> }> = [];
	await authenticate(page, "ana", baseURL!);
	await page.routeWebSocket("**/ws?**", route => {
		if (offline) return route.close();
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
		sockets.push({
			close: async () => {
				await route.close();
				await server.close();
			},
		});
	});
	await page.goto(roomPath(room));
	await expect(chatInput(chatPane(page))).toBeVisible();
	await startBusyTurn(page);
	await say(page, "@chopin second: list the failure modes");
	let row = rowsOf(page).first();
	await expect(row.getByRole("button", { name: "Cancel message from Ana" })).toBeVisible();

	offline = true;
	await sockets.at(-1)!.close();
	await expect(row.getByRole("button", { name: "Cancel message from Ana" })).toHaveCount(0);
	await expect(row.getByRole("button", { name: "Edit message from Ana" })).toHaveCount(0);
	let actions = row.getByRole("button", { name: "Message actions" });
	await expect(actions).toHaveCount(1);

	await page.mouse.move(0, 0);
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
	await row.hover();
	expect(await reachOf(row)).toEqual({ live: true, opacity: "1" });
	await actions.click();
	let item = page.getByRole("menuitem", { name: "Delete", exact: true });
	await expect(item).toBeVisible();
	await expect(item).toHaveAccessibleDescription("");
	await expect(page.getByRole("menu", { name: "Message actions" })).not.toContainText("Cancel");
	await item.click();
	await expect(rowsOf(page)).toHaveCount(0);

	offline = false;
	await expect.poll(() => sockets.length, { timeout: 20_000 }).toBeGreaterThan(1);
	await expect(chatPane(page).getByText("Streaming slowly now.")).toBeVisible({ timeout: TURN });
	await expect(queueOf(page)).toHaveCount(0);
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);
	await page.reload();
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(0);
});

test("on a phone a long queue fades where a row is cut by an edge, and says which way it goes on", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE);
	try {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await startBusyTurn(page);
		for (let number of [1, 2, 3, 4, 5]) await say(page, `@chopin message ${number} for the queue`);
		await expect(rowsOf(page)).toHaveCount(5);
		let list = queueOf(page).getByRole("list");
		// At the end the row above is cut by the top edge, and fades out there.
		await expect.poll(() => edgesOf(list)).toMatchObject({
			above: true,
			below: false,
			fadeAbove: 24,
			fadeBelow: 0,
			cutAbove: true,
		});
		let found = await new AxeBuilder({ page }).include("[data-chat-queue]").analyze();
		expect(found.violations).toEqual([]);

		await list.evaluate(element => element.scrollTop = 0);
		await expect.poll(() => edgesOf(list)).toMatchObject({
			above: false,
			below: true,
			fadeAbove: 0,
			fadeBelow: 24,
			cutBelow: true,
		});
		await expectNoHorizontalOverflow(page);
	} finally {
		await close();
	}
});

test("on a phone the queue fits, its controls are reachable, and it passes an accessibility check", async ({ baseURL, browser, room, seed }) => {
	await seed(SOURCE);
	let { close, page } = await openIsolatedRoom(browser, baseURL!, room, "ana", PHONE);
	try {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await expect(chatInput(chatPane(page))).toBeVisible();
		await startBusyTurn(page);
		await say(page, "@chopin second: list the failure modes and say which of them matter most");
		await say(page, "@chopin third: add a rollout paragraph");

		await expect(rowsOf(page)).toHaveCount(2);
		await expectNoHorizontalOverflow(page);
		for (let name of ["Edit message from Ana", "Cancel message from Ana"]) {
			let button = rowsOf(page).first().getByRole("button", { name });
			await expectInsideViewport(button);
			let box = (await button.boundingBox())!;
			expect(box.width).toBeGreaterThanOrEqual(44);
			for (let offset of [-21, 21]) {
				let reached = await button.evaluate((element, y) => {
					let rectangle = element.getBoundingClientRect();
					let hit = document.elementFromPoint(
						rectangle.left + rectangle.width / 2,
						rectangle.top + rectangle.height / 2 + y,
					);
					return element.contains(hit);
				}, offset);
				expect(reached).toBe(true);
			}
		}
		let found = await new AxeBuilder({ page }).include("[data-chat-queue]").analyze();
		expect(found.violations).toEqual([]);

		await rowsOf(page).first().getByRole("button", { name: "Edit message from Ana" }).tap();
		let field = rowsOf(page).first().getByRole("textbox", { name: "Edit message" });
		await expectInsideViewport(field);
		await field.fill("second: list the failure modes");
		await rowsOf(page).first().getByRole("button", { name: "Save", exact: true }).tap();
		await expect(rowsOf(page).first()).toContainText("second: list the failure modes");
		await rowsOf(page).first().getByRole("button", { name: "Cancel message from Ana" }).tap();
		await expect(rowsOf(page)).toHaveCount(1);
		await expectNoHorizontalOverflow(page);
	} finally {
		await close();
	}
});
