/**
 * Moving a pane's edge stays quick beside a Chat of long replies. Each test counts what the page
 * does, not how long it takes, so that a busy machine cannot fail it and a regression cannot pass:
 *
 * - a step of a Chat resize lays the page out a few times, not once for each reply taller than the
 *   pane that the drag left out of layout.
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
