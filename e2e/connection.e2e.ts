/**
 * What a dropped connection looks like from the page: one connection banner, by the Chat
 * composer where Chat is on screen and at the document where it is not.
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
import {
	allBanners as banners,
	bannerEntrances as entrances,
	connectionBanner as notice,
	heardWords as heard,
	phaseVoice as spoken,
	RESUMED_WAIT as RESUMED,
	watchBanners as watch,
	wordsOutsideBanner,
} from "./banner";
import { readSource } from "./database";
import { authenticate, content, expect, ready, roomPath, status, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

import type { Plan } from "../packages/protocol/index";
import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";

const OFFLINE = "You're offline. Your changes are kept and will sync when you reconnect.";
const RECONNECTING = "Reconnecting. Your changes are kept.";
const CATCHING_UP = "Catching up";
const BACK = "Back online. Your changes are synced";

/**
 * The socket is open again and the server has said nothing on it yet, because the test holds it:
 * the banner says it is catching up, in its own layer, and the live region says so once, for as
 * long as the test looks. Without the hold the sync is over in a few milliseconds, and whether the
 * moment is ever drawn or said is a race, which is not something to assert either way.
 */
async function expectCatchingUp(page: Page): Promise<void> {
	await expect(notice(page)).toHaveAttribute("data-phase", "reconnecting");
	await expect(notice(page)).toHaveAttribute("data-layer", "sync");
	await expect(notice(page)).toContainText(CATCHING_UP);
	await expect(spoken(page)).toHaveText(CATCHING_UP);
}

/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function snap(target: Page | Locator, name: string): Promise<void> {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

function reconnect(page: Page) {
	return notice(page).getByRole("button", { name: "Reconnect", exact: true });
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/**
 * The server these specs run against has its agent off, which the composer would tell in a strip
 * above it. A test that measures the composer across an outage turns the agent on instead, so the
 * strip cannot hide a connection banner's size.
 */
async function agentOn(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
}

/** What the composer says above its field: its own strip, and nothing else. */
function composerStrip(chat: Locator) {
	return chat.locator(".chat-composer").getByRole("status").filter({ hasText: /\S/ });
}

/** What a Chat send meets: it goes through, is cut off as a lost connection would be, or is refused. */
type Send = "pass" | "cut" | "refuse";

/**
 * Proxies the document's socket. With `sends`, each Chat send is also answered as `state.send`
 * says: a cut one closes the socket under it and keeps the connection away (`state.offline`), a
 * refused one is answered as the server would answer it. While `state.hold` is set, what the
 * server says on a socket is kept from the page until `release`, so the page has the socket open
 * and nothing on it yet: its catching up lasts as long as the test looks at it.
 */
function route(page: Page | BrowserContext, { sends = false } = {}) {
	let sockets: WebSocketRoute[] = [];
	let state = { offline: false, send: "pass" as Send, hold: false };
	let held: Array<() => void> = [];
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		let server = socket.connectToServer();
		server.onMessage(message => {
			if (state.hold) held.push(() => socket.send(message));
			else socket.send(message);
		});
		if (sends) {
			socket.onMessage(message => {
				let frame = typeof message === "string"
					? JSON.parse(message) as { kind: string; rid: string }
					: undefined;
				if (frame?.kind !== "chat:send" || state.send === "pass") return void server.send(message);
				if (state.send === "cut") {
					state.offline = true;
					return void socket.close();
				}
				socket.send(JSON.stringify({
					kind: "session:error",
					ts: Math.floor(Date.now() / 1000),
					rid: frame.rid,
					message: "Unavailable",
				}));
			});
		}
		sockets.push(socket);
	});
	let release = () => {
		state.hold = false;
		for (let send of held.splice(0)) send();
	};
	return { sockets, state, ready, release };
}

test("a blip that recovers inside the grace period shows nothing", async ({ join, page }) => {
	await watch(page);
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	await expect(banners(page)).toHaveCount(0);

	await wire.sockets.at(-1)!.close();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(1);

	// Past the moment the old client raised its alarms, and still quiet.
	let until = Date.now() + 1800;
	while (Date.now() < until) {
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
		await expect(status(page)).toHaveAttribute("data-level", "hidden");
		await expect(banners(page)).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(chat.getByText(/Connection lost|Synchronizing|Reconnecting|Offline/))
			.toHaveCount(0);
		await page.waitForTimeout(150);
	}
	await expect(spoken(page)).toHaveText("");
	expect(await heard(page)).toEqual([]);
});

test("a long outage says so once, by the Chat composer, in its phases, keeps the draft, and goes when it returns", async ({ join, page }) => {
	await agentOn(page);
	await watch(page);
	// The widest jitter, so a scheduled retry cannot pass for the online event.
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let input = chatInput(chat);
	let surface = await chat.locator(".composer-surface").boundingBox();

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	// By the composer, above the field, and nowhere else.
	await expect(chat.locator(".chat-composer [data-connection-banner]")).toHaveCount(1);
	await expect(banners(page)).toHaveCount(1);
	await expect(page.locator("[data-document-banner]")).toHaveCount(0);

	// The attempts are counted from the first, as the room's socket tries again.
	await expect(notice(page)).toHaveAttribute("data-phase", "reconnecting");
	await expect(notice(page)).toHaveAttribute("data-layer", "socket");
	await expect(notice(page)).toContainText(RECONNECTING);
	await expect(notice(page).locator("[data-connection-attempt]")).toHaveText(/^attempt \d+$/);
	await expect(reconnect(page)).toHaveCount(0);

	// Still draftable: the composer only holds back the send.
	await input.click();
	await page.keyboard.type("Written while offline");
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.locator(".plan[data-plan-offline]")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect(input).toHaveAttribute("contenteditable", "true");
	// Said once, and nowhere else: not in the header status, and nothing of it in Chat outside the
	// banner; the field under it is exactly the size it was.
	await expect(status(page)).toHaveAttribute("data-level", "hidden");
	expect(await wordsOutsideBanner(chat, /Offline|Reconnecting|Connecting|Connection lost/))
		.toEqual([]);
	expect(await chat.locator(".composer-surface").boundingBox()).toEqual(surface);
	let field = await chat.locator(".composer-surface").boundingBox();
	// Above it, tucked behind its top edge by no more than the half rem the composer gives it.
	await settled(page);
	let bar = await notice(page).boundingBox();
	expect(bar!.y).toBeLessThan(field!.y);
	expect(bar!.y + bar!.height).toBeLessThanOrEqual(field!.y + 9);
	await snap(page, "banner-reconnecting-desktop");

	// Automatic reconnects keep trying, and the attempt count follows them. Reconnect waits until
	// enough of them have failed.
	let attempts: number[] = [];
	await expect(async () => {
		let text = await notice(page).locator("[data-connection-attempt]").textContent({ timeout: 500 })
			.catch(() => null);
		if (text) attempts.push(Number(/\d+/.exec(text)![0]));
		expect(await notice(page).getAttribute("data-phase")).toBe("dropped");
	}).toPass({ timeout: 30_000, intervals: [250] });
	expect(attempts.length).toBeGreaterThan(0);
	expect(attempts).toEqual([...attempts].sort((x, y) => x - y));
	expect(Math.max(...attempts)).toBeGreaterThan(1);
	await expect(notice(page)).toHaveAttribute("data-layer", "socket");
	await expect(notice(page)).toContainText(OFFLINE);
	await expect(reconnect(page)).toBeVisible();
	await expect(notice(page).locator("[data-connection-attempt]")).toHaveCount(0);
	await expect(banners(page)).toHaveCount(1);
	await snap(page, "banner-dropped-desktop");
	await page.keyboard.type(" and kept");

	wire.state.offline = false;
	wire.state.hold = true;
	let sockets = wire.sockets.length;
	let back = Date.now();
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expect.poll(() => wire.sockets.length).toBe(sockets + 1);
	await expectCatchingUp(page);
	wire.release();
	await ready(page);
	expect(wire.sockets.length).toBe(sockets + 1);
	expect(Date.now() - back).toBeLessThan(6000);
	// It says it is back, and what was caught up, for a moment, and then it goes.
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(notice(page)).toContainText("Back online.");
	await expect(notice(page).locator("[data-connection-caught]")).toHaveText(
		"Your changes are synced",
	);
	await expect(reconnect(page)).toHaveCount(0);
	await expect(banners(page)).toHaveCount(1);
	await snap(page, "banner-resumed-desktop");
	await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
	await expect(page.getByRole("alert")).toHaveCount(0);

	// A screen reader heard each phase once, as it began, and that it was over.
	expect(await heard(page)).toEqual([RECONNECTING, OFFLINE, CATCHING_UP, BACK]);
	await expect(spoken(page)).toHaveText("");
	// The banner came in once and went; it never came in twice.
	let entered = await entrances(page);
	expect(entered).toHaveLength(1);
	expect(entered[0]!.animation).toBe("chat-banner-enter");
	expect(Math.min(...entered[0]!.opacity)).toBeLessThan(1);

	await expectChatValue(input, "Written while offline and kept");
	await input.press("Enter");
	await expectChatValue(input, "");
	await expect(chat.getByText("Written while offline and kept", { exact: true })).toBeVisible();
});

test("with reduced motion the banner comes and goes at once, with no entrance", async ({ join, page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await watch(page);
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await expect(notice(page)).toContainText(RECONNECTING);

	wire.state.offline = false;
	wire.state.hold = true;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expectCatchingUp(page);
	wire.release();
	await ready(page);
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
	let entered = await entrances(page);
	expect(entered).toHaveLength(1);
	// Nothing between: no animation, and never a frame that was not fully there.
	expect(entered[0]!.animation).toBe("none");
	expect(entered[0]!.opacity.every(opacity => opacity === 1)).toBe(true);
	expect(await heard(page)).toEqual([RECONNECTING, CATCHING_UP, BACK]);
});

test("Reconnect asks again at once, and the banner says it is back when the connection returns", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(reconnect(page)).toBeVisible({ timeout: 25_000 });
	// Pressing it is another attempt now, not after the rest of a long wait.
	let before = wire.sockets.length;
	wire.state.offline = false;
	await reconnect(page).click();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(before);
	await ready(page);
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
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
	await expect(banners(page)).toHaveCount(0);
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
	// The loss is shown once it has outlasted the grace, as a blip is not; only a shown loss is
	// said to be over, so Ana stays away until the banner has told it.
	await expect(notice(page)).toBeVisible();

	ana.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	// What said the changes were kept is gone or no longer says they were synced, and what is left
	// is the one alert that says the last edits were not: shown, in view, and not hidden behind the
	// banner. The banner never says "synced" over edits that were not saved.
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(notice(page)).not.toContainText(/synced/);
	await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
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

test("on a phone, Chat shows the banner by its composer, and Reconnect after repeated failures", async ({ baseURL, browser, room }) => {
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
		await agentOn(page);
		await watch(page);
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
		let surface = await chat.locator(".composer-surface").boundingBox();

		wire.state.offline = true;
		await wire.sockets.at(-1)!.close();
		// Chat is all that shows, so the one banner stands by its composer, and is the only one.
		await expect(notice(page)).toBeVisible();
		await expect(banners(page)).toHaveCount(1);
		await expect(chat.locator(".chat-composer [data-connection-banner]")).toHaveCount(1);
		await expect(page.locator("[data-document-banner]")).toHaveCount(0);
		await expect(notice(page)).toContainText(RECONNECTING);
		// The field keeps its size and its place: the banner takes the transcript's room.
		expect(await chat.locator(".composer-surface").boundingBox()).toEqual(surface);
		await expect(chat.getByRole("button", { name: /Reconnect|Reload|Retry/ })).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
		await expectInsideViewport(notice(page));
		await snap(page, "banner-reconnecting-phone");

		await expect(reconnect(page)).toBeVisible({ timeout: 25_000 });
		await expect(notice(page)).toHaveAttribute("data-phase", "dropped");
		await expect(reconnect(page)).toBeInViewport();
		await expect(notice(page)).toContainText(OFFLINE);
		await expectNoHorizontalOverflow(page);
		await expectInsideViewport(notice(page));
		await snap(page, "banner-dropped-phone");

		wire.state.offline = false;
		wire.state.hold = true;
		await reconnect(page).tap({ timeout: 8_000 });
		await expectCatchingUp(page);
		await expectInsideViewport(notice(page));
		wire.release();
		await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
		await expectInsideViewport(notice(page));
		await expectNoHorizontalOverflow(page);
		await snap(page, "banner-resumed-phone");
		await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
		expect(await heard(page)).toEqual([
			RECONNECTING,
			OFFLINE,
			RECONNECTING,
			CATCHING_UP,
			BACK,
		]);
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
	await expect(notice(page)).toHaveAttribute("data-layer", "socket");
	await expect(notice(page)).toContainText(RECONNECTING);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");

	// The network comes back while the probe is still out: the page does not wait on it.
	hanging = false;
	wire.state.offline = false;
	let attempts = wire.sockets.length;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(banners(page)).toHaveCount(0, { timeout: 8_000 });
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

/**
 * Every entrance and slide has finished. The reconnecting banner's spinner turns for as long as the
 * phase lasts, by design, so an animation that repeats forever is not one to wait for: waiting for
 * it would outlast the phase itself.
 */
async function settled(page: Page): Promise<void> {
	await page.waitForFunction(() =>
		document.getAnimations().every(a =>
			a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity
		)
	);
}

/** What the composer says online, on a server whose agent is off. */
const REPLIES_OFF = "Replies are off on this server.";

/**
 * A lost connection is one banner, by the composer. The composer's own strip tells a state that is
 * not the connection (here, that the server's agent is off), so it says nothing while the banner is
 * up, comes back by itself when the connection and the banner's goodbye are over, and nothing else
 * about the connection or about availability is drawn anywhere in Chat.
 */
async function expectOneNotice(
	page: Page,
	wire: ReturnType<typeof route>,
	chat: Locator,
	shot: string,
) {
	await expect(composerStrip(chat)).toHaveText(REPLIES_OFF);
	await snap(page, `${shot}-online`);

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await expect(notice(page)).toContainText(RECONNECTING);
	await expect(chat.locator(".chat-composer [data-connection-banner]")).toHaveCount(1);
	await expect(composerStrip(chat)).toHaveCount(0);
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(chat.getByRole("alert")).toHaveCount(0);
	expect(
		await wordsOutsideBanner(
			chat,
			/unavailable|Chopin is off|off on this server|offline|Reconnecting|Connecting|Connection lost/i,
		),
	).toEqual([]);
	await expect(chat.getByRole("button", { name: /Reconnect|Reload|Retry/ })).toHaveCount(0);
	await snap(page, `${shot}-offline`);

	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(composerStrip(chat)).toHaveCount(0);
	await expect(banners(page)).toHaveCount(0, RESUMED);
	await expect(composerStrip(chat)).toHaveText(REPLIES_OFF);
}

test("a lost connection is one banner: the composer's own strip is gone while it shows, and back when it clears", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");
	await expectOneNotice(page, wire, chatPane(page), "agent-off-desktop");
});

/**
 * A /research the connection could not take is told by the one banner and nothing else: the
 * composer's own "Reconnecting" line would be a second strip about the same connection, and is
 * gone, not waiting, when the connection returns. The agent is on, so no other strip is there.
 */
async function expectResearchOffline(
	page: Page,
	wire: ReturnType<typeof route>,
	chat: Locator,
	shot: string,
) {
	let draft = chatInput(chat);
	await expect(composerStrip(chat)).toHaveCount(0);

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await fillChat(draft, "/research what changed upstream?");
	await draft.press("Enter");
	// The command stays in the draft for when the connection is back, and the banner is the only
	// word about the connection, with no Retry of its own beside the composer.
	await expectChatValue(draft, "/research what changed upstream?");
	await expect(composerStrip(chat)).toHaveCount(0);
	expect(await wordsOutsideBanner(chat, /Reconnecting|try again in a moment/)).toEqual([]);
	await expect(chat.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await snap(page, `${shot}-offline`);

	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expect(banners(page)).toHaveCount(0, RESUMED);
	await expect(composerStrip(chat)).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Retry" })).toHaveCount(0);
}

test("a /research pressed while offline adds no second connection banner, and nothing of it is left when the connection returns", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	await agentOn(page);
	let wire = route(page);
	await wire.ready;
	await join("ana");
	await expectResearchOffline(page, wire, chatPane(page), "research-offline-desktop");
});

test("on a phone, a /research pressed while offline adds no second connection banner either", async ({ baseURL, browser, room }) => {
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
		await agentOn(page);
		wire = route(page);
		await wire.ready;
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);
		await tab(page, /^Chat/).tap();
		await settled(page);
		await expectResearchOffline(page, wire, chatPane(page), "research-offline-phone");
		await expectNoHorizontalOverflow(page);
	} finally {
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
});

/**
 * A Chat send the connection cut off is told by the one banner and nothing else. The composer
 * draws no failure for it, neither for the moments before the banner shows nor once it does, and
 * none is left when the connection returns; the draft stays for the person to send again.
 */
async function expectCutSend(
	page: Page,
	wire: ReturnType<typeof route>,
	chat: Locator,
	shot: string,
) {
	let draft = chatInput(chat);
	let failure = chat.getByText(/Message not sent|Check the connection/);
	await fillChat(draft, "Cut off on its way");
	wire.state.send = "cut";
	await draft.press("Enter");

	// Sampled from the cut until the banner has been up a while, so nothing can come and go unseen.
	let until = Date.now() + 2500;
	while (Date.now() < until) {
		await expect(failure).toHaveCount(0);
		await expect(page.locator("[data-error-banner]")).toHaveCount(0);
		await page.waitForTimeout(100);
	}
	await expect(notice(page)).toBeVisible();
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await expectChatValue(draft, "Cut off on its way");
	await snap(page, `${shot}-offline`);

	wire.state.send = "pass";
	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(banners(page)).toHaveCount(0, RESUMED);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(failure).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await snap(page, `${shot}-online`);

	await expectChatValue(draft, "Cut off on its way");
	await draft.press("Enter");
	await expectChatValue(draft, "");
	await expect(chat.getByText("Cut off on its way", { exact: true })).toBeVisible();
}

/**
 * A server's refusal of a send is told by its failure banner while the connection is up. While the
 * connection banner shows it gives way, so that banner is the only one, and the same banner, with
 * the same words, is back once the connection has returned and said so; it goes only when the
 * person sends again.
 */
async function expectRefusalGivesWay(
	page: Page,
	wire: ReturnType<typeof route>,
	chat: Locator,
	shot: string,
) {
	let draft = chatInput(chat);
	let refusal = chat.getByRole("alert").filter({ hasText: "Message not sent: Unavailable" });
	await fillChat(draft, "Refused by the server");
	wire.state.send = "refuse";
	await draft.press("Enter");
	await expect(refusal).toBeVisible();
	await expect(refusal).toHaveAttribute("data-error-banner", "");
	await expect(refusal).toHaveAttribute("data-kind", "send");
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(1);
	await expectChatValue(draft, "Refused by the server");
	await snap(page, `${shot}-online`);

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(refusal).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await expectChatValue(draft, "Refused by the server");
	await snap(page, `${shot}-offline`);

	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	// The connection says it is back first, and is the one banner while it does.
	await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
	await expect(banners(page)).toHaveCount(1);
	await expect(refusal).toHaveCount(0);
	await expect(refusal).toBeVisible(RESUMED);
	await expect(refusal).toHaveText(/^Message not sent: Unavailable\s*Retry$/);
	await expect(banners(page)).toHaveCount(1);
	await expect(page.getByRole("alert")).toHaveCount(1);
	await expectChatValue(draft, "Refused by the server");

	wire.state.send = "pass";
	await draft.press("Enter");
	await expectChatValue(draft, "");
	await expect(refusal).toHaveCount(0);
	await expect(chat.getByText("Refused by the server", { exact: true })).toBeVisible();
}

/** A 390 px phone with Chat open, its routed sockets closed again when the body is done. */
async function onPhoneChat(
	{ baseURL, browser, room }: { baseURL: string | undefined; browser: Browser; room: string },
	body: (page: Page, wire: ReturnType<typeof route>) => Promise<void>,
) {
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
		await agentOn(page);
		wire = route(page, { sends: true });
		await wire.ready;
		await authenticate(page, "ana", baseURL!);
		await page.goto(roomPath(room));
		await ready(page);
		await tab(page, /^Chat/).tap();
		await settled(page);
		await body(page, wire);
		await expectNoHorizontalOverflow(page);
	} finally {
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
}

test("a send the connection cut off leaves no failure beside the connection banner, and none when the connection returns", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	await agentOn(page);
	let wire = route(page, { sends: true });
	await wire.ready;
	await join("ana");
	await expectCutSend(page, wire, chatPane(page), "cut-send-desktop");
});

test("on a phone, a send the connection cut off leaves no failure beside the connection banner either", async ({ baseURL, browser, room }) => {
	test.setTimeout(90_000);
	await onPhoneChat(
		{ baseURL, browser, room },
		(page, wire) => expectCutSend(page, wire, chatPane(page), "cut-send-phone"),
	);
});

test("a server's refusal of a send gives way to the connection banner and is back, unchanged, when the connection returns", async ({ join, page }) => {
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	await agentOn(page);
	let wire = route(page, { sends: true });
	await wire.ready;
	await join("ana");
	await expectRefusalGivesWay(page, wire, chatPane(page), "refused-send-desktop");
});

test("on a phone, a server's refusal of a send gives way to the connection banner and is back, unchanged, when the connection returns", async ({ baseURL, browser, room }) => {
	test.setTimeout(90_000);
	await onPhoneChat(
		{ baseURL, browser, room },
		(page, wire) => expectRefusalGivesWay(page, wire, chatPane(page), "refused-send-phone"),
	);
});

test("on a phone, a lost connection is still one banner, with nothing else above the composer", async ({ baseURL, browser, room }) => {
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
		await tab(page, /^Chat/).tap();
		await settled(page);
		await expectOneNotice(page, wire, chatPane(page), "agent-off-phone");
		await expectNoHorizontalOverflow(page);
	} finally {
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
});

test("on a phone, the banner takes its own room at the top of Document and by the composer in Chat, never over their content, and is one banner, said once, as the tabs switch", async ({ baseURL, browser, room, seed }) => {
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
		await watch(page);
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

		// However many banners the page holds at once, at any moment, and any alert added to it, are
		// recorded from here on.
		await page.evaluate(() => {
			let most = 0;
			let alerts = 0;
			new MutationObserver(records => {
				most = Math.max(most, document.querySelectorAll("[data-banner]").length);
				for (let record of records) {
					for (let node of record.addedNodes) {
						if (node instanceof Element && node.matches("[role=alert], [role=alert] *")) alerts++;
					}
				}
			}).observe(document.body, { childList: true, subtree: true });
			(window as unknown as { seen: () => { most: number; alerts: number } }).seen = () => ({
				most,
				alerts,
			});
		});

		wire.state.offline = true;
		await wire.sockets.at(-1)!.close();
		await expect(notice(page)).toBeVisible();
		await settled(page);
		await expect(banners(page)).toHaveCount(1);

		// Document: Chat is not on screen, so the banner is the document's, under the top bar, and the
		// first heading starts below it.
		await expect(page.locator("[data-document-banner] [data-connection-banner]")).toHaveCount(1);
		// The Chat pane is still mounted but off screen: it holds no banner of its own.
		await expect(chatPane(page).locator("[data-banner]")).toHaveCount(0);
		await expect(notice(page)).toContainText(RECONNECTING);
		let bar = await page.locator(".phone-top-bar").boundingBox();
		let alert = await notice(page).boundingBox();
		expect(alert!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
		await expectNotOver(notice(page), content(page).locator("h1").first());
		await expectNotOver(notice(page), content(page).getByText("The first paragraph"));
		await expectInsideViewport(notice(page));
		await expectNotCovered(notice(page));
		await snap(page, "banner-phone-document");

		await tab(page, /^Chat/).tap();
		await settled(page);
		// Chat is on screen now, so the banner is by its composer, and the document has none. It is
		// a new element, but the page holds its phase above both, so it neither waits out the grace
		// period again nor is heard a second time.
		await expect(banners(page)).toHaveCount(1);
		await expect(chat.locator(".chat-composer [data-connection-banner]")).toHaveCount(1);
		await expect(page.locator("[data-document-banner]")).toHaveCount(0);
		await expectNotOver(chat.locator("[data-chat-scroll]"), notice(page));
		await expectNotOver(notice(page), chat.locator(".composer-surface"));
		await expectInsideViewport(notice(page));
		await expectNotCovered(notice(page));
		await snap(page, "banner-phone-chat");

		await tab(page, /^Document/).tap();
		await settled(page);
		await expect(banners(page)).toHaveCount(1);
		await expect(page.locator("[data-document-banner] [data-connection-banner]")).toHaveCount(1);
		// The Chat pane is still mounted but off screen: it holds no banner of its own.
		await expect(chatPane(page).locator("[data-banner]")).toHaveCount(0);
		await expectNotOver(notice(page), content(page).locator("h1").first());
		// One banner at every moment, no alert of any kind, and the live region said it once.
		expect(
			await page.evaluate(() =>
				(window as unknown as { seen: () => { most: number; alerts: number } }).seen()
			),
		).toEqual({ most: 1, alerts: 0 });
		expect(await heard(page)).toEqual([RECONNECTING]);

		wire.state.offline = false;
		wire.state.hold = true;
		await page.evaluate(() => dispatchEvent(new Event("online")));
		await expectCatchingUp(page);
		wire.release();
		await expect(notice(page)).toHaveAttribute("data-phase", "resumed");
		await expect(banners(page)).toHaveCount(0, RESUMED);
		// Nothing is left reserved at the top of the document once it has gone.
		await settled(page);
		let after = await content(page).locator("h1").first().boundingBox();
		expect(after!.y).toBeGreaterThan(bar!.y + bar!.height);
		expect(after!.y).toBeLessThan(alert!.y + alert!.height);
		expect(await heard(page)).toEqual([RECONNECTING, CATCHING_UP, BACK]);
	} finally {
		await Promise.all(wire?.sockets.map(socket => socket.close()) ?? []);
		await context.close();
	}
});

test("in a compact window, the banner is by the composer in Chat and at the top of the document, one at a time as they take turns, and said once", async ({ join, page }) => {
	await page.setViewportSize({ width: 723, height: 900 });
	await watch(page);
	let wire = route(page);
	await wire.ready;
	await join("ana");

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(notice(page)).toBeVisible();
	await settled(page);
	let frame = page.locator(".workspace-frame");
	// The document is on screen: in flow, above the panel that holds both panes, taking its own room.
	await expect(banners(page)).toHaveCount(1);
	await expect(page.locator("[data-document-banner] [data-connection-banner]")).toHaveCount(1);
	// The Chat pane is still mounted but off screen: it holds no banner of its own.
	await expect(chatPane(page).locator("[data-banner]")).toHaveCount(0);
	await expectNotOver(notice(page), frame);

	await tab(page, /^Chat/).click();
	await settled(page);
	await expect(banners(page)).toHaveCount(1);
	await expect(chatPane(page).locator(".chat-composer [data-connection-banner]")).toHaveCount(1);
	await expect(page.locator("[data-document-banner]")).toHaveCount(0);
	await expectNotOver(chatPane(page).locator("[data-chat-scroll]"), notice(page));
	await tab(page, /^Document/).click();
	await settled(page);
	await expect(banners(page)).toHaveCount(1);
	await expect(page.locator("[data-document-banner] [data-connection-banner]")).toHaveCount(1);
	// The Chat pane is still mounted but off screen: it holds no banner of its own.
	await expect(chatPane(page).locator("[data-banner]")).toHaveCount(0);
	// Said once, whichever pane carried it.
	expect(await heard(page)).toEqual([RECONNECTING]);

	wire.state.offline = false;
	wire.state.hold = true;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await expectCatchingUp(page);
	wire.release();
	await expect(banners(page)).toHaveCount(0, RESUMED);
	expect(await heard(page)).toEqual([RECONNECTING, CATCHING_UP, BACK]);
});
