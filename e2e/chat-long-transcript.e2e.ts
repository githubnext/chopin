/**
 * A long Chat stays quick to hover, to type beside and to resize. Each test counts what the page
 * does, not how long it takes, so that a busy machine cannot fail it and a regression cannot pass:
 *
 * - the pointer crossing messages restyles a message or two, not the whole transcript;
 * - a key typed in the composer renders none of the transcript's messages again;
 * - a step of a Chat resize lays the page out a few times, not once for each message;
 * - opening it mounts the newest messages first, so the document and the newest line are not held
 *   back by the whole history, and the older ones follow.
 */

import { chatInput } from "./chat-input";
import { expect, test } from "./room";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Chat } from "../packages/protocol/index";
import type { CDPSession, Locator, Page } from "@playwright/test";

const MESSAGES = 160;

test.use({ trace: "off", viewport: { width: 1440, height: 900 } });

declare global {
	interface Window {
		__timeFormats: number;
	}
}

function transcript(): Chat.Entry[] {
	return Array.from({ length: MESSAGES }, (_, index) => ({
		id: `message-${index}`,
		author: index % 4 === 3
			? { kind: "agent" as const }
			: { kind: "member" as const, handle: ["ana", "ben", "cy"][index % 3]! },
		text: `Message ${index} about the rollout plan, and what it still needs from each team before `
			+ "the next one begins.",
		ts: 1_700_000_000 + index * 120,
		...(index % 3 === 0 ? { reactions: [{ emoji: "👍", handles: ["ben"] }] } : {}),
	}));
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function opened(seed: (source: string, state?: SeedState) => Promise<void>) {
	return seed("# Long Chat\n\nThe rollout goes team by team.\n", { transcript: transcript() });
}

/** Two frames, so that anything the last event scheduled for the next frame has happened. */
function settle(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
		)
	);
}

/** The older messages are mounted after the newest; the whole transcript is there. */
function complete(chat: Locator) {
	return expect(chat.locator("[data-chat-message-id]")).toHaveCount(MESSAGES);
}

async function layouts(cdp: CDPSession): Promise<number> {
	let { metrics } = await cdp.send("Performance.getMetrics");
	return metrics.find(metric => metric.name === "LayoutCount")!.value;
}

test("the pointer crossing a long Chat's messages restyles them, not the whole transcript", async ({ join, page, seed }) => {
	await opened(seed);
	await join("ana");
	let chat = chatOf(page);
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeVisible();
	await complete(chat);
	await settle(page);
	let elements = await chat.evaluate(element => element.querySelectorAll("*").length);
	let box = (await chat.locator("[data-chat-scroll]").boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + 80);
	await settle(page);

	let browser = page.context().browser()!;
	await browser.startTracing(page, { categories: ["devtools.timeline"] });
	for (let y = box.y + 80; y < box.y + box.height - 120; y += 12) {
		await page.mouse.move(box.x + box.width / 2, y);
		await settle(page);
	}
	let trace = JSON.parse((await browser.stopTracing()).toString()) as {
		traceEvents: { name: string; args?: { elementCount?: number } }[];
	};
	let restyled = trace.traceEvents
		.filter(event => event.name === "UpdateLayoutTree")
		.map(event => event.args?.elementCount ?? 0);
	expect(restyled.length).toBeGreaterThan(0);
	// Hiding every other message's toolbar with `:has()` of the transcript restyled all of it, and
	// the page around it, on each move: more elements than the transcript has.
	expect(Math.max(...restyled)).toBeLessThan(elements / 4);
});

test("a key typed in the composer of a long Chat renders none of its messages again", async ({ join, page, seed }) => {
	await opened(seed);
	// Each message's heading formats its time as it renders, so the formats count the renders.
	await page.addInitScript(() => {
		window.__timeFormats = 0;
		let format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!;
		Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
			...format,
			get() {
				window.__timeFormats++;
				return format.get!.call(this);
			},
		});
		let time = Date.prototype.toLocaleTimeString;
		Date.prototype.toLocaleTimeString = function(
			...args: Parameters<typeof Date.prototype.toLocaleTimeString>
		) {
			window.__timeFormats++;
			return time.apply(this, args);
		};
	});
	await join("ana");
	let chat = chatOf(page);
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeVisible();
	await complete(chat);
	let input = chatInput(chat);
	await input.click();
	await settle(page);
	let before = await page.evaluate(() => window.__timeFormats);

	await page.keyboard.type("The lease renews every few seconds", { delay: 20 });
	await settle(page);

	// Rendering the transcript again formats each message's time at least once: 160 for each key.
	let formats = await page.evaluate(() => window.__timeFormats);
	expect(formats - before).toBeLessThan(MESSAGES);
});

test("a step of a Chat resize lays the page out a few times, not once for each message", async ({ join, page, seed }) => {
	await opened(seed);
	await join("ana");
	let chat = chatOf(page);
	let handle = page.getByRole("separator", { name: "Resize chat" });
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeVisible();
	await complete(chat);
	await settle(page);
	let cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	let start = (await handle.boundingBox())!;
	let x = start.x + start.width / 2;
	let y = start.y + start.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await settle(page);
	let before = await layouts(cdp);

	let steps = 10;
	for (let step = 1; step <= steps; step++) {
		await page.mouse.move(x - step * 6, y);
		await settle(page);
	}

	// Each message measured itself and wrote what it found as the pane changed width, so each step
	// laid the page out once for every message: over a thousand layouts for these ten steps.
	expect(await layouts(cdp) - before).toBeLessThan(steps * 4);
	await page.mouse.up();
});

test("opening a long Chat mounts its newest messages first and the older ones after", async ({ join, page, seed }) => {
	await opened(seed);
	// The messages mounted by the first commit that mounts any, counted as it lands.
	await page.addInitScript(() => {
		let w = window as unknown as { __firstMounted?: string[] };
		new MutationObserver(() => {
			if (w.__firstMounted) return;
			let mounted = [...document.querySelectorAll<HTMLElement>("[data-chat-message-id]")];
			if (mounted.length > 0) w.__firstMounted = mounted.map(item => item.dataset.chatMessageId!);
		}).observe(document, { childList: true, subtree: true });
	});
	await join("ana");
	let chat = chatOf(page);
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeVisible();

	let first = await page.evaluate(() =>
		(window as unknown as { __firstMounted: string[] }).__firstMounted
	);
	// A tall pane shows about a dozen of these; rendering all of them with the document kept both
	// off the screen for seconds on a long Chat.
	expect(first.length).toBeLessThanOrEqual(40);
	expect(first).toContain(`message-${MESSAGES - 1}`);
	await complete(chat);
	// In order, oldest first, with the newest line still in view.
	let ids = await chat.locator("[data-chat-message-id]").evaluateAll(items =>
		items.map(item => (item as HTMLElement).dataset.chatMessageId)
	);
	expect(ids).toEqual(transcript().map(entry => entry.id));
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeInViewport();
});
