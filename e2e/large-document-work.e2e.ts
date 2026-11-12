/**
 * A long document with diagrams stays quick to read and work in. Each test counts how many elements
 * one style recalculation touches, not how long it takes, so that a busy machine cannot fail it and
 * a regression cannot pass.
 *
 * Chromium keeps one set of what a change in any `:has()` may restyle below the element it asks of,
 * shared by every `:has()` rule on the page, and some of those rules restyle every `p`, `span` or
 * `div` below. So a `:has()` that asks of a large element (the page, the document's scroller, the
 * editor) restyled the whole document whenever Chromium checked it again, which a block or a tooltip
 * coming or going was enough for: scrolling, selecting a passage and pressing Escape each restyled
 * nearly every element on the page.
 */

import { content, expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

test.use({ trace: "off", viewport: { width: 1440, height: 900 } });

let diagram = {
	type: "architecture",
	motion: "trace",
	nodes: [
		{ id: "web", label: "Web", row: 0, col: 0 },
		{ id: "gateway", label: "Gateway", row: 0, col: 1 },
		{ id: "store", label: "Session store", row: 0, col: 2 },
		{ id: "signer", label: "Token signer", row: 1, col: 1 },
	],
	edges: [["web", "gateway", "logs in"], ["gateway", "store", "renews"], [
		"gateway",
		"signer",
		"issues",
	]],
};

function document(): string {
	let sections = Array.from(
		{ length: 40 },
		(_, index) =>
			`## Section ${index}\n\nThe gateway renews the lease every few seconds, and the store keeps `
			+ "it until the holder goes away. Each team signs off before the next one begins.\n\n"
			+ "| Service | Owner | State |\n| --- | --- | --- |\n| gateway | ana | live |\n"
			+ "| store | ben | live |\n| signer | cy | draft |\n\n"
			+ "```ts\nexport function renew(lease: Lease) {\n  return store.extend(lease.id);\n}\n```\n\n"
			+ (index % 4 === 0 ? `\`\`\`seecode\n${JSON.stringify(diagram)}\n\`\`\`\n\n` : "")
			+ "- one step\n- the next step\n- the last step\n",
	);
	return `# Document work\n\n${sections.join("\n")}`;
}

function transcript(): Chat.Entry[] {
	return Array.from({ length: 12 }, (_, index) => ({
		id: `message-${index}`,
		author: index % 2
			? { kind: "agent" as const }
			: { kind: "member" as const, handle: ["ana", "ben", "cy"][index % 3]! },
		text: `Message ${index}: what does the rollout still need?`,
		ts: 1_700_000_000 + index * 120,
	}));
}

/** Two frames, so that anything the last event scheduled for the next frame has happened. */
function settle(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
		)
	);
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
	return Math.max(0, ...restyled);
}

function elements(page: Page): Promise<number> {
	return page.evaluate(() => window.document.querySelectorAll("*").length);
}

async function open(
	page: Page,
	seed: (source: string, state?: { transcript: Chat.Entry[] }) => Promise<void>,
	join: (handle: string) => Promise<unknown>,
) {
	await seed(document(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("svg.sc-svg").first()).toBeVisible();
	await expect(content(page).getByRole("heading", { name: "Section 39" })).toBeAttached();
	await page.waitForTimeout(1000);
	await settle(page);
}

test("scrolling a long document restyles a part of the page, not all of it", async ({ join, page, seed }) => {
	await open(page, seed, join);
	let box = (await content(page).boundingBox())!;
	await page.mouse.move(box.x + 200, 450);
	let total = await elements(page);
	let most = await mostRestyled(page, async () => {
		for (let step = 0; step < 8; step++) {
			await page.mouse.wheel(0, 900);
			await settle(page);
		}
	});
	expect(most).toBeLessThan(total / 2);
});

test("selecting a passage and pressing Escape restyle a part of the page", async ({ join, page, seed }) => {
	await open(page, seed, join);
	let paragraph = content(page).locator(":scope > p").nth(2);
	await paragraph.click();
	await settle(page);
	let total = await elements(page);
	let most = await mostRestyled(page, async () => {
		for (let step = 0; step < 4; step++) {
			await page.keyboard.press("Shift+ArrowRight");
			await settle(page);
		}
		await page.keyboard.press("Escape");
		await settle(page);
	});
	expect(most).toBeLessThan(total / 2);
});
