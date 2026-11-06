/**
 * What a dropped connection looks like from the page.
 *
 * Routed rather than `context.setOffline`, which leaves an established socket
 * alone. Proxying the socket is the only way to be the thing that drops it.
 */

import { mkdir } from "node:fs/promises";

import { $importPlan } from "../packages/dialect/src/index";

import * as PlanRoom from "../apps/server/src/plan/room";
import * as Y from "../apps/server/node_modules/yjs";
import { REGISTRY } from "../apps/server/src/testing/peer";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { readSource } from "./database";
import { inBetween, top, trace } from "./motion";
import { authenticate, content, expect, ready, roomPath, status, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

import type { Plan } from "../packages/protocol/index";
import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";

const OFFLINE = "You're offline. Your changes are kept and will sync when you reconnect.";

/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function snap(target: Page | Locator, name: string): Promise<void> {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

/** The one notice a lost connection brings, at the top of the document's content. */
function notice(page: Page) {
	return page.locator("[data-offline-notice]");
}

function retry(page: Page) {
	return notice(page).getByRole("button", { name: "Retry", exact: true });
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function route(page: Page | BrowserContext) {
	let sockets: WebSocketRoute[] = [];
	let state = { offline: false };
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		socket.connectToServer();
		sockets.push(socket);
	});
	return { sockets, state, ready };
}

test("a blip that recovers inside the grace period shows nothing", async ({ join, page }) => {
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	await expect(notice(page)).toHaveCount(0);

	await wire.sockets.at(-1)!.close();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(1);

	// Past the moment the old client raised its alarms, and still quiet.
	let until = Date.now() + 1800;
	while (Date.now() < until) {
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
		await expect(status(page)).toHaveAttribute("data-level", "hidden");
		await expect(notice(page)).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(chat.getByText(/Connection lost|Synchronizing|Reconnecting|Offline/))
			.toHaveCount(0);
		await page.waitForTimeout(150);
	}
	await expect(page.locator("[data-offline-status]")).toHaveText("");
});

test("a long outage says so once, at the top of the document, keeps the draft, and goes when it returns", async ({ join, page }) => {
	// The widest jitter, so a scheduled retry cannot pass for the online event.
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let input = chatInput(chat);
	let composer = await chat.locator(".chat-composer").boundingBox();
	let surface = await chat.locator(".composer-surface").boundingBox();

	wire.state.offline = true;
	// The notice eases open a frame at a time, pushing the document down by its own height.
	let opening = await trace(page.locator("[data-workspace-document-swap]"), top, async () => {
		await wire.sockets.at(-1)!.close();
		await expect(notice(page)).toBeVisible();
	});
	expect(inBetween(opening).length).toBeGreaterThan(0);

	// Still draftable: the composer only holds back the send.
	await input.click();
	await page.keyboard.type("Written while offline");
	await expect(notice(page).getByRole("alert")).toHaveText(OFFLINE);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.locator(".plan[data-plan-offline]")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect(input).toHaveAttribute("contenteditable", "true");
	// Said once, and nowhere else: not in the header status, not in Chat, and the composer is
	// exactly the size it was.
	await expect(status(page)).toHaveAttribute("data-level", "hidden");
	await expect(chat.getByText(/Offline|Reconnecting|Connecting|Connection lost/)).toHaveCount(0);
	await expect(chat.getByRole("button", { name: /Reconnect|Reload|Retry/ })).toHaveCount(0);
	expect(await chat.locator(".chat-composer").boundingBox()).toEqual(composer);
	expect(await chat.locator(".composer-surface").boundingBox()).toEqual(surface);
	await snap(page, "offline-desktop");

	// Automatic reconnects keep trying, and Retry waits until enough of them have failed.
	await expect(retry(page)).toHaveCount(0);
	await expect(retry(page)).toBeVisible({ timeout: 25_000 });
	await expect(notice(page).getByRole("alert")).toHaveText(`${OFFLINE}Retry`);
	await snap(page, "offline-retry-desktop");
	await page.keyboard.type(" and kept");

	wire.state.offline = false;
	let attempts = wire.sockets.length;
	let back = Date.now();
	// The notice goes the way it came, and a screen reader hears once that it is over.
	let closing = await trace(page.locator("[data-workspace-document-swap]"), top, async () => {
		await page.evaluate(() => dispatchEvent(new Event("online")));
		await ready(page);
		await expect(notice(page)).toHaveCount(0);
	});
	expect(inBetween(closing).length).toBeGreaterThan(0);
	expect(wire.sockets.length).toBe(attempts + 1);
	expect(Date.now() - back).toBeLessThan(6000);
	await expect(page.locator("[data-offline-status]")).toHaveText("Reconnected");
	await expect(page.getByRole("alert")).toHaveCount(0);

	await expectChatValue(input, "Written while offline and kept");
	await input.press("Enter");
	await expectChatValue(input, "");
	await expect(chat.getByText("Written while offline and kept", { exact: true })).toBeVisible();
});

test("with reduced motion the notice comes and goes at once, with nothing between", async ({ join, page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	let opening = await trace(page.locator("[data-workspace-document-swap]"), top, async () => {
		await wire.sockets.at(-1)!.close();
		await expect(notice(page)).toBeVisible();
	});
	expect(inBetween(opening)).toEqual([]);
	await expect(notice(page).getByRole("alert")).toHaveText(OFFLINE);

	wire.state.offline = false;
	let closing = await trace(page.locator("[data-workspace-document-swap]"), top, async () => {
		await page.evaluate(() => dispatchEvent(new Event("online")));
		await ready(page);
		await expect(notice(page)).toHaveCount(0);
	});
	expect(inBetween(closing)).toEqual([]);
	await expect(page.locator("[data-offline-status]")).toHaveText("Reconnected");
});

test("Retry asks again at once, and the notice goes when the connection returns", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(retry(page)).toBeVisible({ timeout: 25_000 });
	// Pressing it is another attempt now, not after the rest of a long wait.
	let before = wire.sockets.length;
	wire.state.offline = false;
	await retry(page).click();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(before);
	await ready(page);
	await expect(notice(page)).toHaveCount(0);
});

test("a send pressed during a blip goes once the connection is back", async ({ join, page }) => {
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let input = chatInput(chat);
	await input.fill("Pressed during a blip");

	await wire.sockets.at(-1)!.close();
	await input.press("Enter");

	await expectChatValue(input, "");
	await expect(chat.getByText("Pressed during a blip", { exact: true })).toBeVisible();
	await expect(notice(page)).toHaveCount(0);
});

/*
 * The server rebuilt the document while Ana was away, so she never heard the
 * reset. What she typed in the meantime belongs to a history that no longer
 * exists; keeping it forked her document, and everything she typed afterwards
 * was acknowledged and never reached anyone.
 */
test("edits made during a blip are dropped, and said to be, when the document was rebuilt meanwhile", async ({ join, page, room, seed }) => {
	await seed("# Rebuilt\n\nShared prose.\n");
	let ana = route(page);
	await ana.ready;
	await join("ana");

	let opened: Plan.Open.Reply | undefined;
	let benServer: WebSocketRoute | undefined;
	let reset = Promise.withResolvers<void>();
	let ben = await join("ben", {});
	await ben.routeWebSocket("**/ws?**", socket => {
		let server = socket.connectToServer();
		benServer = server;
		socket.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "plan:open") opened = frame as Plan.Open.Reply;
				if (frame.kind === "plan:reset") reset.resolve();
			}
			socket.send(message);
		});
	});
	await ben.reload();
	await ready(ben);
	await expect.poll(() => opened !== undefined).toBe(true);

	ana.state.offline = true;
	await ana.sockets.at(-1)!.close();
	await content(page).getByText("Shared prose.").selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type(" STALE");

	// A Callout with no id is well-formed MDX and outside the dialect, so the
	// room rejects the batch and rebuilds under a fresh epoch.
	let port = Number(new URL(ben.url()).port);
	let peer = await PlanRoom.restore(
		opened!.epoch,
		Buffer.from(opened!.update, "base64"),
		await readSource(port, room),
		[],
	);
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		$importPlan('<Callout type="note">\n\tText.\n</Callout>\n', {
			registry: REGISTRY,
			validate: false,
		});
	}, { discrete: true });
	await PlanRoom.settle();
	let update = Y.encodeStateAsUpdate(peer.doc, before);
	peer.doc.destroy();
	benServer!.send(JSON.stringify({
		kind: "plan:update",
		ts: 0,
		rid: crypto.randomUUID(),
		id: crypto.randomUUID(),
		epoch: opened!.epoch,
		update: Buffer.from(update).toString("base64"),
	}));
	await reset.promise;

	ana.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	// The notice that said changes were kept is gone once reconnected, and what is left is the one
	// alert that says the last edits were not: shown, in view, and not hidden behind the notice.
	await expect(notice(page)).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(1);
	await expect(page.getByRole("alert")).toContainText(
		"Your last edits couldn't be saved because the document changed while you were offline.",
	);
	await expect(page.getByRole("alert")).toBeInViewport();
	await snap(page, "lost-edits-after-offline-desktop");
	await expect(content(page)).not.toContainText("STALE");

	// Back in step: what Ana types now reaches Ben.
	await content(page).getByText("Shared prose.").selectText();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type(" AFTER");
	await expect(content(ben)).toContainText("Shared prose. AFTER");
	await expect(content(ben)).not.toContainText("STALE");

	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a reload keeps an unsent Chat message", async ({ join, page }) => {
	await join("ana");
	let input = chatInput(chatPane(page));
	await input.fill("Not sent before the reload");
	await page.reload();
	await ready(page);
	await expectChatValue(chatInput(chatPane(page)), "Not sent before the reload");
});

test("on a phone, Chat shows the same notice at its top, and Retry after repeated failures", async ({ baseURL, browser, room }) => {
	test.setTimeout(90_000);
	let wire: ReturnType<typeof route> | undefined;
	let context = await browser.newContext({
		baseURL,
		deviceScaleFactor: 3,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		wire = route(page);
		await wire.ready;
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).tap();
		let chat = chatPane(page);
		// Chat slides in from the side; measure it once it has settled.
		await page.waitForFunction(() =>
			document.getAnimations().every(a => a.playState !== "running")
		);
		let composer = await chat.locator(".chat-composer").boundingBox();

		wire.state.offline = true;
		await wire.sockets.at(-1)!.close();
		// Chat is all that shows, so the one notice stands above it, and is the only one.
		await expect(notice(page)).toBeVisible();
		await expect(page.locator("[data-offline-notice]")).toHaveCount(1);
		await expect(page.getByRole("alert")).toHaveText(OFFLINE);
		// The composer keeps its size and its place: the notice takes the transcript's room.
		expect(await chat.locator(".chat-composer").boundingBox()).toEqual(composer);
		await expect(chat.getByRole("button", { name: /Reconnect|Reload|Retry/ })).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
		await expectInsideViewport(notice(page));
		await snap(page, "offline-phone");

		await expect(retry(page)).toBeVisible({ timeout: 25_000 });
		await expect(retry(page)).toBeInViewport();
		await expectNoHorizontalOverflow(page);
		await snap(page, "offline-retry-phone");

		wire.state.offline = false;
		await retry(page).tap({ timeout: 8_000 });
		await expect(notice(page)).toHaveCount(0);
	} finally {
		// A routed socket that is still open holds its context open.
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
});

test("a lost connection says so even while the request that asks why it was lost never answers, and carries on when the network returns", async ({ join, page }) => {
	// A network that drops packets rather than refusing them: the probe never comes back.
	let probes = 0;
	let hanging = false;
	await page.route("**/ws?**", route => {
		if (hanging && route.request().headers()["x-chopin-socket-probe"] === "1") {
			probes++;
			return;
		}
		return route.continue();
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");

	hanging = true;
	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect.poll(() => probes).toBeGreaterThan(0);
	// The probe is still unanswered, and the page says it is offline all the same.
	await expect(notice(page)).toBeVisible();
	await expect(notice(page).getByRole("alert")).toHaveText(OFFLINE);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");

	// The network comes back while the probe is still out: the page does not wait on it.
	hanging = false;
	wire.state.offline = false;
	let attempts = wire.sockets.length;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	await expect(notice(page)).toHaveCount(0);
	expect(wire.sockets.length).toBeGreaterThan(attempts);
});

/** `below` begins at or under the bottom edge of `above`, so nothing of either lies over the other. */
async function expectNotOver(above: Locator, below: Locator): Promise<void> {
	let [top, bottom] = [await above.boundingBox(), await below.boundingBox()];
	expect(top, "the notice has a box").not.toBeNull();
	expect(bottom, "the content has a box").not.toBeNull();
	expect(bottom!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 0.5);
}

/** Nothing lies over the notice: what is at its centre is the notice itself, so its Retry can be pressed. */
async function expectNotCovered(target: Locator): Promise<void> {
	let covered = await target.evaluate(element => {
		let box = element.getBoundingClientRect();
		let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		return !hit || !element.contains(hit);
	});
	expect(covered, "something lies over the notice").toBe(false);
}

function tab(page: Page, name: RegExp) {
	return page.getByRole("navigation", { name: "Workspace view" }).getByRole("button", { name });
}

async function settled(page: Page): Promise<void> {
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
}

test("on a phone, the notice takes its own room at the top of Document and of Chat, never over their first content, and stays one notice as the tabs switch", async ({ baseURL, browser, room, seed }) => {
	test.setTimeout(120_000);
	await seed(
		"# A document with real content\n\nThe first paragraph is the first thing a reader meets.\n\n"
			+ "The second paragraph follows it.\n",
	);
	let wire: ReturnType<typeof route> | undefined;
	let context = await browser.newContext({
		baseURL,
		deviceScaleFactor: 3,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		wire = route(page);
		await wire.ready;
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);

		// Enough in Chat that its first message sits at the top once scrolled there.
		await tab(page, /^Chat/).tap();
		let chat = chatPane(page);
		await settled(page);
		let input = chatInput(chat);
		for (let index = 1; index <= 8; index++) {
			let text = `Message ${index}: ${
				"the harp needs new strings and a careful tuning ".repeat(3)
			}`;
			await fillChat(input, text);
			await input.press("Enter");
			await expect(chat.getByText(text, { exact: true })).toBeVisible();
		}
		await tab(page, /^Document/).tap();
		await settled(page);

		wire.state.offline = true;
		await wire.sockets.at(-1)!.close();
		await expect(notice(page)).toBeVisible();
		await settled(page);
		await expect(page.locator("[data-offline-notice]")).toHaveCount(1);

		// Document: the notice floats under the top bar and the first heading starts below it.
		let bar = await page.locator(".phone-top-bar").boundingBox();
		let alert = await notice(page).boundingBox();
		expect(alert!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
		await expectNotOver(notice(page), content(page).locator("h1").first());
		await expectNotOver(notice(page), content(page).getByText("The first paragraph"));
		await expectInsideViewport(notice(page));
		await expectNotCovered(notice(page));
		await snap(page, "offline-phone-document");

		// The one notice: marked, and watched for any alert that is added to the page from here on.
		await notice(page).evaluate(element => {
			element.setAttribute("data-same-notice", "");
			let added = 0;
			new MutationObserver(records => {
				for (let record of records) {
					for (let node of record.addedNodes) {
						if (node instanceof Element && node.matches("[role=alert], [role=alert] *")) added++;
					}
				}
			}).observe(document.body, { childList: true, subtree: true });
			(window as unknown as { alertsAdded: () => number }).alertsAdded = () => added;
		});

		await tab(page, /^Chat/).tap();
		await settled(page);
		// The same element, not a fresh one that would wait out the grace period and be heard again.
		await expect(page.locator("[data-offline-notice][data-same-notice]")).toHaveCount(1);
		await expect(page.locator("[data-offline-notice]")).toHaveCount(1);
		await chat.locator("[data-chat-scroll]").evaluate(element => {
			element.scrollTop = 0;
		});
		await expectNotOver(notice(page), chat.getByText(/^Message 1:/));
		await expectInsideViewport(notice(page));
		await expectNotCovered(notice(page));
		await snap(page, "offline-phone-chat");
		await expect(page.locator("[data-offline-status]")).toHaveText("");

		await tab(page, /^Document/).tap();
		await settled(page);
		await expect(page.locator("[data-offline-notice][data-same-notice]")).toHaveCount(1);
		await expectNotOver(notice(page), content(page).locator("h1").first());
		expect(
			await page.evaluate(() => (window as unknown as { alertsAdded: () => number }).alertsAdded()),
		).toBe(0);
		await expect(page.locator("[data-offline-status]")).toHaveText("");

		wire.state.offline = false;
		await page.evaluate(() => dispatchEvent(new Event("online")));
		await expect(notice(page)).toHaveCount(0);
		// Nothing is left reserved at the top of the document once it has gone.
		await settled(page);
		await expect(page.locator("[data-offline-status]")).toHaveText("Reconnected");
		let after = await content(page).locator("h1").first().boundingBox();
		expect(after!.y).toBeGreaterThan(bar!.y + bar!.height);
		expect(after!.y).toBeLessThan(alert!.y + alert!.height);
	} finally {
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
});

test("in a compact window, one notice sits above Chat and the document and is not mounted again as they take turns", async ({ join, page }) => {
	await page.setViewportSize({ width: 723, height: 900 });
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await settled(page);
	let frame = page.locator(".workspace-frame");
	// In flow: above the panel that holds both panes, taking its own room.
	await expectNotOver(notice(page), frame);
	await notice(page).evaluate(element => element.setAttribute("data-same-notice", ""));

	await tab(page, /^Chat/).click();
	await settled(page);
	await expect(page.locator("[data-offline-notice][data-same-notice]")).toHaveCount(1);
	await expectNotOver(notice(page), chatPane(page));
	await tab(page, /^Document/).click();
	await settled(page);
	await expect(page.locator("[data-offline-notice][data-same-notice]")).toHaveCount(1);
	await expect(page.locator("[data-offline-status]")).toHaveText("");

	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expect(notice(page)).toHaveCount(0);
});
