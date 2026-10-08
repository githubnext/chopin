/**
 * What a dropped connection looks like from the page.
 *
 * Routed rather than `context.setOffline`, which leaves an established socket
 * alone. Proxying the socket is the only way to be the thing that drops it.
 */

import { $importPlan } from "../packages/dialect/src/index";

import * as PlanRoom from "../apps/server/src/plan/room";
import * as Y from "../apps/server/node_modules/yjs";
import { REGISTRY } from "../apps/server/src/testing/peer";
import { chatInput, expectChatValue } from "./chat-input";
import { readSource } from "./database";
import { content, expect, ready, status, test } from "./room";

import type { Plan } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function route(page: Page) {
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
	let connection = chat.locator(".composer-connection");
	await expect(connection).toBeEmpty();

	await wire.sockets.at(-1)!.close();
	await expect.poll(() => wire.sockets.length).toBeGreaterThan(1);

	// Past the moment the old client raised its alarms, and still quiet.
	let until = Date.now() + 1800;
	while (Date.now() < until) {
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
		await expect(status(page)).toHaveAttribute("data-level", "hidden");
		await expect(connection).toBeEmpty();
		await expect(chat.getByText(/Connection lost|Synchronizing|Reconnecting|Offline/))
			.toHaveCount(0);
		await page.waitForTimeout(150);
	}
});

test("a long outage says so once, keeps the draft, and comes back on the online event", async ({ join, page }) => {
	// The widest jitter, so a scheduled retry cannot pass for the online event.
	await page.addInitScript(() => {
		Math.random = () => 0.999;
	});
	let wire = route(page);
	await wire.ready;
	await join("ana");
	let chat = chatPane(page);
	let input = chatInput(chat);
	let connection = chat.locator(".composer-connection");
	let composer = await chat.locator(".chat-composer").boundingBox();

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();

	// Still draftable: the composer only holds back the send.
	await input.click();
	await page.keyboard.type("Written while offline");
	await expect(connection).toHaveText("Reconnecting…");
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(page.locator(".plan[data-plan-offline]")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect(input).toHaveAttribute("contenteditable", "true");
	// Nothing was inserted above the composer to push the transcript.
	await expect(chat.getByText(/Connection lost|Synchronizing/)).toHaveCount(0);
	expect(await chat.locator(".chat-composer").boundingBox()).toEqual(composer);

	await expect(connection).toHaveText("Offline", { timeout: 10_000 });
	// One action for one state: the document header's, not a second one here.
	await expect(chat.getByRole("button", { name: /Reconnect|Reload/ })).toHaveCount(0);
	await page.keyboard.type(" and kept");

	wire.state.offline = false;
	let attempts = wire.sockets.length;
	let back = Date.now();
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	expect(wire.sockets.length).toBe(attempts + 1);
	expect(Date.now() - back).toBeLessThan(3000);

	await expect(connection).toBeEmpty();
	await expectChatValue(input, "Written while offline and kept");
	await input.press("Enter");
	await expectChatValue(input, "");
	await expect(chat.getByText("Written while offline and kept", { exact: true })).toBeVisible();
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
	await expect(chat.locator(".composer-connection")).toBeEmpty();
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
	await content(page).getByText("Shared prose.").click();
	await page.keyboard.press("End");
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
	await expect(page.getByRole("alert")).toContainText(
		"Your last edits couldn't be saved because the document changed while you were offline.",
	);
	await expect(content(page)).not.toContainText("STALE");

	// Back in step: what Ana types now reaches Ben.
	await content(page).getByText("Shared prose.").click();
	await page.keyboard.press("End");
	await page.keyboard.type(" AFTER");
	await expect(content(ben)).toContainText("Shared prose. AFTER");
	await expect(content(ben)).not.toContainText("STALE");

	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});
