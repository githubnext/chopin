/**
 * Moving a pane's edge and opening a thread stay quick beside a Chat of long replies. Each test
 * counts what the page does, not how long it takes, so that a busy machine cannot fail it and a
 * regression cannot pass:
 *
 * - a step of a Chat resize lays the page out a few times, not once for each reply taller than the
 *   pane that the drag left out of layout;
 * - opening and closing a thread, which changes Chat's width, restyles a part of the page, not all of it;
 * - switching the document's view, or expanding the document over Chat, and back restyles a part of
 *   the page, and what is closed stays out of reach: not focused by Tab, not in the accessibility
 *   tree, not found by find in page.
 */

import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { CDPSession, Locator, Page } from "@playwright/test";

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
	// A long Chat mounts its newest messages first and the rest when the page is idle; every count
	// here is of the whole Chat.
	await expect(chat.locator("[data-chat-message-id]")).toHaveCount(MESSAGES);
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

/** What axe finds wrong in `selector`. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
	let result = await new AxeBuilder({ page }).include(selector).analyze();
	return result.violations.map(violation =>
		`${violation.id}: ${violation.help} ${
			violation.nodes.map(node => node.html.slice(0, 120)).join(" ")
		}`
	);
}

/** Every name in the page's accessibility tree, as Chromium exposes it. */
async function exposedNames(page: Page): Promise<string> {
	let cdp = await page.context().newCDPSession(page);
	let { nodes } = await cdp.send("Accessibility.getFullAXTree");
	await cdp.detach();
	return nodes
		.filter(node => !node.ignored)
		.map(node => String(node.name?.value ?? ""))
		.join("\n");
}

/** Whether Tab, forwards or back, ever puts focus inside `closed`, over `presses` presses each way. */
async function tabReaches(page: Page, closed: Locator, presses = 40): Promise<boolean> {
	for (let key of ["Tab", "Shift+Tab"]) {
		for (let press = 0; press < presses; press++) {
			await page.keyboard.press(key);
			if (await closed.evaluate(element => element.contains(window.document.activeElement))) {
				return true;
			}
		}
	}
	return false;
}

/** What find in page would find: Chromium's `window.find` searches the rendered text. */
function findable(page: Page, text: string): Promise<boolean> {
	return page.evaluate(text => {
		window.getSelection()?.removeAllRanges();
		return (window as unknown as { find: (text: string) => boolean }).find(text);
	}, text);
}

test("switching to Decisions and back restyles part of the page, and the closed view is out of reach", async ({ join, page, seed }) => {
	let chat = await open(page, seed, join);
	let elements = await page.evaluate(() => window.document.querySelectorAll("*").length);
	await chat.locator(`[data-chat-message-id="message-${MESSAGES - 2}"]`)
		.getByText(`Message ${MESSAGES - 2}:`).click();
	await settle(page);
	let documentView = page.locator('[data-document-view="plan"]');
	let decisions = page.getByRole("button", { name: "Decisions", exact: true });
	let documentButton = page.getByRole("button", { name: "Document", exact: true });

	await decisions.click();
	await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeFocused();
	await settle(page);
	await expect(page.getByRole("heading", { name: "Section 3" })).toHaveCount(0);
	await expect(documentView.getByText("The gateway renews the lease").first()).toBeHidden();
	expect(await exposedNames(page)).not.toContain("Section 3");
	expect(await axeViolations(page, "[data-workspace-document-swap]")).toEqual([]);
	expect(await findable(page, "Section 3")).toBe(false);
	expect(await tabReaches(page, documentView)).toBe(false);
	// Tab made the page keyboard-driven; a pointer press makes it pointer-driven again before counting.
	await page.getByRole("heading", { name: "Decisions", exact: true }).click({ force: true });
	await settle(page);

	await documentButton.hover();
	await settle(page);
	let showing = await mostRestyled(page, async () => {
		await documentButton.click();
		await expect(page.getByRole("heading", { name: "Section 3" })).toBeVisible();
		await settle(page);
	});
	// Focus stays where the press left it, as it did: not lost to the page, not in the view now closed.
	expect(
		await page.evaluate(() => {
			let active = window.document.activeElement;
			return active !== window.document.body
				&& !active?.closest('[data-document-view="decisions"]');
		}),
	).toBe(true);
	expect(await findable(page, "Section 3")).toBe(true);
	// The closed view was taken out of the page and made inert, and the workspace's travel was a custom
	// property of its root: showing the document again restyled every element in it and the page.
	expect(showing).toBeLessThan(elements / 2);
});

test("expanding the document over Chat and back restyles part of the page, and the closed Chat is out of reach", async ({ join, page, seed }) => {
	let chat = await open(page, seed, join);
	let elements = await page.evaluate(() => window.document.querySelectorAll("*").length);
	let message = chat.locator(`[data-chat-message-id="message-${MESSAGES - 2}"]`);
	await message.getByText(`Message ${MESSAGES - 2}:`).click();
	await settle(page);
	let pane = page.locator("aside.workspace-chat-panel");

	let expand = page.getByRole("button", { name: "Expand document" });
	await expand.hover();
	await settle(page);
	let expanding = await mostRestyled(page, async () => {
		await expand.click();
		await expect(chat).toHaveCount(0);
		await settle(page);
	});
	await expect(message).toBeHidden();
	expect(await exposedNames(page)).not.toContain(`Message ${MESSAGES - 2}:`);
	expect(await axeViolations(page, "aside.workspace-chat-panel")).toEqual([]);
	expect(await findable(page, `Message ${MESSAGES - 2}:`)).toBe(false);
	expect(await tabReaches(page, pane)).toBe(false);
	// Tab made the page keyboard-driven; a pointer press makes it pointer-driven again before counting.
	await page.getByRole("heading", { name: "Section 3" }).click();
	await settle(page);

	// Found before counting: finding a control by its role reads the styles of every element, the
	// skipped Chat's too, which a person's press does not.
	let show = page.getByRole("button", { name: /^Show chat/ });
	await show.hover();
	await settle(page);
	let showing = await mostRestyled(page, async () => {
		await show.click();
		await expect(message).toBeVisible();
		await settle(page);
	});
	expect(await findable(page, `Message ${MESSAGES - 2}:`)).toBe(true);
	// Chat was made inert as it left and taken out of the page once it had: each restyled all of it.
	expect(expanding).toBeLessThan(elements / 2);
	expect(showing).toBeLessThan(elements / 2);
});

test("on a phone with reduced motion, the document takes the pointer again after Decisions", async ({ join, seed }) => {
	await seed(document(), { transcript: transcript() });
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	await page.emulateMedia({ reducedMotion: "reduce" });
	let views = page.getByRole("navigation", { name: "Workspace view" });
	await views.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeFocused();
	await views.getByRole("button", { name: "Document", exact: true }).click();
	let heading = page.getByRole("heading", { name: "Section 0" });
	await expect(heading).toBeVisible();
	await settle(page);
	// A closed view stays in the page, over the open one in a phone's stack and transparent there; it
	// must take no pointer, or every press on the document lands on it.
	let box = (await heading.boundingBox())!;
	expect(
		await page.evaluate(
			({ x, y }) =>
				!!window.document.elementFromPoint(x, y)?.closest('[data-document-view="plan"]'),
			{
				x: box.x + box.width / 2,
				y: box.y + box.height / 2,
			},
		),
	).toBe(true);
});
