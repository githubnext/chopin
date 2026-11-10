import { connectionBanner, heardWords, phaseVoice, watchBanners } from "./banner";
import { readSource } from "./database";
import { content, expect, ready, test } from "./room";

import type { WebSocketRoute } from "@playwright/test";

test("a return does not say changes are synced before their acknowledgement", async ({ baseURL, join, page, room }) => {
	let sockets: WebSocketRoute[] = [];
	let state = { offline: false, holdUpdates: false, holdAcks: false };
	let updates: Array<() => void> = [];
	let acks: Array<() => void> = [];
	await page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		let server = socket.connectToServer();
		socket.onMessage(message => {
			let frame = typeof message === "string" ? JSON.parse(message) as { kind: string } : undefined;
			if (state.holdUpdates && frame?.kind === "plan:update") {
				updates.push(() => server.send(message));
			} else server.send(message);
		});
		server.onMessage(message => {
			let frame = typeof message === "string" ? JSON.parse(message) as { kind: string } : undefined;
			if (state.holdAcks && frame?.kind === "plan:ack") {
				acks.push(() => socket.send(message));
			} else socket.send(message);
		});
		sockets.push(socket);
	});
	await watchBanners(page);
	await join("ana");
	await content(page).click();
	await page.keyboard.type("Base text");
	let port = Number(new URL(baseURL!).port);
	await expect.poll(() => readSource(port, room)).toMatch(/Base text/);

	// A blip leaves the editor writable during the grace, so this edit enters the outbox.
	state.offline = true;
	await sockets.at(-1)!.close();
	await page.keyboard.type(" and an edit made offline");
	let banner = connectionBanner(page);
	let voice = phaseVoice(page);
	await expect(banner).toContainText("Reconnecting");

	// Hold the replay before it can reach the server, then hold the acknowledgement separately.
	state.holdUpdates = true;
	state.holdAcks = true;
	state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	await ready(page);
	await expect(banner).toHaveAttribute("data-phase", "resumed");
	await expect.poll(() => updates.length).toBeGreaterThan(0);
	expect(await banner.innerText()).not.toContain("Your changes are synced");
	await expect(voice).toHaveText("Back online.");
	expect(await readSource(port, room)).not.toMatch(/edit made offline/);

	state.holdUpdates = false;
	for (let release of updates.splice(0)) release();
	await expect.poll(() => acks.length).toBeGreaterThan(0);
	await expect.poll(() => readSource(port, room)).toMatch(/edit made offline/);
	expect(await banner.innerText()).not.toContain("Your changes are synced");
	for (let release of acks.splice(0)) release();
	await expect(banner).toContainText("Your changes are synced");

	// An edit made while the return is still visible cannot leave a stale synced claim behind.
	await content(page).click();
	await page.keyboard.type(" more");
	await expect.poll(() => acks.length).toBeGreaterThan(0);
	await expect(banner).not.toContainText("Your changes are synced");
	state.holdAcks = false;
	for (let release of acks.splice(0)) release();
	await expect(banner).toContainText("Your changes are synced");
	// The changing caught line does not announce a second return.
	expect((await heardWords(page)).filter(words => words.startsWith("Back online."))).toEqual([
		"Back online.",
	]);
});
