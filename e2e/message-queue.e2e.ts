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
	await expect(queueOf(page)).toContainText("1 waiting for Chopin");

	await expect(transcriptHas(page, "and the rollback plan")).toHaveCount(1, { timeout: TURN });
	await expect(transcriptHas(page, "second: list the failure modes")).toHaveCount(1);
	await page.reload();
	await expect(transcriptHas(page, "second: list the failure modes and the rollback plan"))
		.toHaveCount(1);
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
	await expect(rowsOf(ana).getByRole("button")).toHaveCount(4);

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

test("a long message keeps to one line, and more than three fold behind a control that says how many", async ({ join, seed }) => {
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
	await expect(rowsOf(page)).toHaveCount(3);
	let more = queueOf(page).getByRole("button", { name: "2 more" });
	await expect(more).toHaveAttribute("aria-expanded", "false");
	await more.click();
	await expect(rowsOf(page)).toHaveCount(5);
	await expect(queueOf(page).getByRole("button", { name: "Show fewer" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await queueOf(page).getByRole("button", { name: "Show fewer" }).click();
	await expect(rowsOf(page)).toHaveCount(3);
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
		.toHaveCount(2);
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
			expect(box.height).toBeGreaterThanOrEqual(24);
			expect(box.width).toBeGreaterThanOrEqual(24);
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
