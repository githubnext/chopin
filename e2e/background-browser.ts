/**
 * A Chromium started here and not by Playwright, so that one of its tabs can really be in the
 * background.
 *
 * Playwright makes every page it drives look focused and in front, whatever its window is doing,
 * which also keeps a page's timers at full speed: a tab it launched cannot be hidden, in
 * headless or headed Chromium, however many pages are in front of it. Started by hand, with its
 * own pages driven over the DevTools protocol and Playwright's overrides left off
 * (`noDefaults`), a tab behind another reads `hidden` and has its timers held to one a second,
 * as a person's background tab does, and `Page.setWebLifecycleState` freezes one as the browser
 * does to a tab it has left alone. Neither needs a display: the browser is headless.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import type { BrowserContext, CDPSession, Page } from "@playwright/test";

export type BackgroundBrowser = {
	context: BrowserContext;
	/** Opens a page in front of every other, which are then really in the background. */
	toFront(): Promise<Page>;
	/** Freezes or thaws the page the way the browser does to a tab it has left alone. */
	freeze(page: Page, frozen: boolean): Promise<void>;
	close(): Promise<void>;
};

async function freePort(): Promise<number> {
	let socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	let { port } = socket;
	socket.stop(true);
	return port;
}

export async function backgroundBrowser(): Promise<BackgroundBrowser> {
	let port = await freePort();
	let profile = await mkdtemp(join(tmpdir(), "chopin-background-"));
	let child = spawn(chromium.executablePath(), [
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--no-sandbox",
		"about:blank",
	], { stdio: "ignore" });
	let endpoint = `http://127.0.0.1:${port}`;
	let up = false;
	for (let deadline = Date.now() + 15_000; !up && Date.now() < deadline; await Bun.sleep(100)) {
		up = await fetch(`${endpoint}/json/version`).then(response => response.ok, () => false);
	}
	if (!up) {
		child.kill();
		await rm(profile, { recursive: true, force: true });
		throw new Error("the browser did not start");
	}
	let browser = await chromium.connectOverCDP(endpoint, { noDefaults: true } as never);
	let context = browser.contexts()[0]!;
	// The session that froze a page stays open until it is thawed.
	let sessions = new Map<Page, CDPSession>();
	return {
		context,
		async toFront() {
			let front = await context.newPage();
			await front.goto("about:blank");
			await front.bringToFront();
			return front;
		},
		async freeze(page, frozen) {
			let session = sessions.get(page);
			if (!session) {
				session = await context.newCDPSession(page);
				await session.send("Page.enable");
				sessions.set(page, session);
			}
			await session.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
		},
		async close() {
			await browser.close().catch(() => {});
			child.kill();
			await rm(profile, { recursive: true, force: true });
		},
	};
}
