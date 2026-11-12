/**
 * Moving a pane's edge and opening a thread stay quick beside a Chat of long replies. Each test
 * counts what the page does, not how long it takes, so that a busy machine cannot fail it and a
 * regression cannot pass:
 *
 * - a step of a Chat resize lays the page out a few times, not once for each reply taller than the
 *   pane that the drag left out of layout;
 * - opening and closing a thread, which changes Chat's width, restyles a part of the page, not all of it.
 */

import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { CDPSession, Page } from "@playwright/test";

const MESSAGES = 60;

test.use({ trace: "off", viewport: { width: 1440, height: 900 } });

function paragraph(index: number): string {
	return `Paragraph ${index} on how the lease renews, which service holds it, and what happens to the `
		+ "requests in flight when the holder goes away before the next one takes over.";
}

/** Every other message is a reply of many paragraphs, taller than the Chat pane. */
function transcript(): Chat.Entry[] {
	return Array.from({ length: MESSAGES }, (_, index) => ({
		id: `message-${index}`,
		author: index % 2
			? { kind: "agent" as const }
			: { kind: "member" as const, handle: ["ana", "ben", "cy"][index % 3]! },
		text: index % 2
			? Array.from({ length: 14 }, (_, line) => paragraph(line)).join("\n\n")
			: `Message ${index}: what does the rollout still need?`,
		ts: 1_700_000_000 + index * 120,
	}));
}

function document(): string {
	let sections = Array.from(
		{ length: 12 },
		(_, index) =>
			`## Section ${index}\n\nThe gateway renews the lease every few seconds.\n\n`
			+ "| Service | Owner |\n| --- | --- |\n| gateway | ana |\n| store | ben |\n\n"
			+ "```ts\nexport function renew(lease: Lease) {\n  return store.extend(lease.id);\n}\n```\n",
	);
	return `# Pane work\n\n${sections.join("\n")}`;
}

/** Two frames, so that anything the last event scheduled for the next frame has happened. */
function settle(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
		)
	);
}

async function layouts(cdp: CDPSession): Promise<number> {
	let { metrics } = await cdp.send("Performance.getMetrics");
	return metrics.find(metric => metric.name === "LayoutCount")!.value;
}

/** The most elements any one style recalculation touched while `action` ran. */
async function mostRestyled(page: Page, action: () => Promise<void>): Promise<number> {
	let browser = page.context().browser()!;
	await browser.startTracing(page, { categories: ["devtools.timeline"] });
	await action();
	let trace = JSON.parse((await browser.stopTracing()).toString()) as {
		traceEvents: { name: string; args?: { elementCount?: number } }[];
	};
	let restyled = trace.traceEvents
		.filter(event => event.name === "UpdateLayoutTree")
		.map(event => event.args?.elementCount ?? 0);
	expect(restyled.length).toBeGreaterThan(0);
	return Math.max(...restyled);
}

async function open(
	page: Page,
	seed: (source: string, state?: { transcript: Chat.Entry[] }) => Promise<void>,
	join: (handle: string) => Promise<unknown>,
) {
	await seed(document(), { transcript: transcript() });
	await join("ana");
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	await expect(chat.locator(`[data-chat-message-id="message-${MESSAGES - 1}"]`)).toBeVisible();
	await settle(page);
	return chat;
}

test("a step of a Chat resize beside replies taller than the pane lays the page out a few times", async ({ join, page, seed }) => {
	await open(page, seed, join);
	let handle = page.getByRole("separator", { name: "Resize chat" });
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

	// Each reply taller than the pane read its toolbar's place on every step, and each read laid out
	// again the block the drag had left out of layout: about thirty layouts a step here.
	expect(await layouts(cdp) - before).toBeLessThan(steps * 4);
	await page.mouse.up();
});

test("opening and closing a thread restyles part of the page, not all of it", async ({ join, page, seed }) => {
	let chat = await open(page, seed, join);
	let elements = await page.evaluate(() => window.document.querySelectorAll("*").length);
	let message = chat.locator(`[data-chat-message-id="message-${MESSAGES - 2}"]`);
	await message.hover();
	// A first press marks the page as used with a pointer, which restyles it once; that is not this test's.
	await message.getByText(`Message ${MESSAGES - 2}:`).click();
	await settle(page);
	let reply = message.getByRole("button", { name: "Reply in thread" });
	await expect(reply).toBeVisible();
	let opening = await mostRestyled(page, async () => {
		await reply.click();
		await expect(page.getByRole("button", { name: "Close thread" })).toBeVisible();
		await settle(page);
	});
	let closing = await mostRestyled(page, async () => {
		await page.getByRole("button", { name: "Close thread" }).click();
		await expect(page.getByRole("button", { name: "Close thread" })).toHaveCount(0);
		await settle(page);
	});
	// Chat's width and the thread's were custom properties of the workspace's root, so each change of
	// them restyled every element under it.
	expect(opening).toBeLessThan(elements / 2);
	expect(closing).toBeLessThan(elements / 2);
});
