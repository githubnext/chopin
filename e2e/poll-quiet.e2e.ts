import { expect, test } from "./room";

import type { Page } from "@playwright/test";

/** What `GET /api/connector/machines` answers: one machine of the person's own. */
function listed(connected: boolean) {
	return {
		machines: [{
			id: "M_box",
			label: "build-box",
			teammate: false,
			favorite: false,
			repositories: ["octo-org/score"],
			autoRun: false,
			shared: false,
			finishing: 0,
			createdAt: 1_000,
			lastSeenAt: 2_000,
			connected,
			version: null,
			hostname: null,
			platform: null,
			agent: null,
			sandbox: null,
			service: false,
			planner: false,
			reauthorize: false,
		}],
	};
}

/**
 * Count the commits of React's root: a browser build of React reports each commit to a DevTools
 * hook that is there before it loads, which is what "the page rendered again" means.
 */
async function countCommits(page: Page) {
	await page.addInitScript(() => {
		let count = 0;
		Object.defineProperty(window, "__commits", { get: () => count });
		Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
			value: {
				supportsFiber: true,
				renderers: new Map(),
				inject: () => 1,
				onCommitFiberRoot: () => void count++,
				onCommitFiberUnmount() {},
				onPostCommitFiberRoot() {},
				checkDCE() {},
			},
		});
	});
}

const commits = (page: Page) =>
	page.evaluate(() => (window as unknown as { __commits: number }).__commits);

/**
 * Until the page has stopped rendering for what it is still doing as it opens: its last settling
 * renders come in bursts a second or so after the document, later on a slow machine.
 */
async function quiet(page: Page) {
	let last = await commits(page);
	let since = Date.now();
	while (Date.now() - since < 1_200) {
		await page.waitForTimeout(100);
		let now = await commits(page);
		if (now !== last) [last, since] = [now, Date.now()];
	}
}

/**
 * Until the page has taken in what it was answered: every task already waiting has run, the
 * answer's body read and acted on, since idle time comes only after them.
 */
function settled(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve => requestIdleCallback(() => resolve(), { timeout: 1_000 }))
	);
}

/**
 * The Projects list's socket tells every page that has the repository open whenever any document
 * in it changes or has a decision answered, the other tests' documents included, and the page
 * reads the list again and draws it, twice over. None of that is a poll of the person's machines,
 * so on this page's socket only what is said of this document is heard.
 */
async function hearOwnDocumentOnly(page: Page, room: string) {
	await page.routeWebSocket(/\/ws\/sidebar/, route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let { kind, channelId } = JSON.parse(message) as { kind: string; channelId?: string };
				let ofDocument = kind === "sidebar:catalogue" || kind === "sidebar:decisions";
				if (ofDocument && channelId !== room) return;
			}
			route.send(message);
		});
	});
}

test("a poll of the person's machines that answers what the page holds renders nothing; a change does", async ({ join, page, room, seed }) => {
	await seed("# Quiet polls\n\nOne paragraph, so the page has something to draw.\n");
	await countCommits(page);
	await hearOwnDocumentOnly(page, room);
	let online = true;
	let answered = 0;
	await page.route("**/api/connector/machines", async route => {
		answered++;
		await route.fulfill({ json: listed(online) });
	});
	let choice = 0;
	await page.route("**/api/documents/*/machine", async route => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			json: { choice: null, favorite: null, automatic: null, machines: [] },
		});
		// Counted once the page has the answer, not when it asked.
		choice++;
	});
	await join("quiet-polls");
	// The first answers are news: the list and the choice arrive.
	await expect.poll(() => answered).toBeGreaterThan(0);
	await expect.poll(() => choice).toBeGreaterThan(0);
	await quiet(page);

	// The page asks again whenever its window regains focus, as it does every few seconds. Each
	// answer repeats the last one. A round starts once the page has taken in the last one's answer,
	// as the next poll does seconds later: a choice read that another overtakes before its answer is
	// acted on is not the read the page follows, and that the page draws.
	let before = await commits(page);
	for (let round = 0; round < 3; round++) {
		let asked = { machines: answered, choice };
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect.poll(() => answered).toBeGreaterThan(asked.machines);
		await expect.poll(() => choice).toBeGreaterThan(asked.choice);
		await settled(page);
	}
	await page.waitForTimeout(300);
	expect(await commits(page)).toBe(before);

	// A machine going offline is news, so the same probe sees the page render.
	online = false;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => commits(page)).toBeGreaterThan(before);
});
