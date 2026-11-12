/**
 * A document stays quick to read while somebody else writes in it. Each test counts what the page
 * does, not how long it takes, so that a busy machine cannot fail it and a regression cannot pass:
 *
 * - a collaborator starting paragraphs and typing in a table cell restyles what they changed, not
 *   every element on the reader's page;
 * - a key typed into a document with no comments or decisions in its margin measures no margin.
 */

import { authenticate, content, expect, ready, roomPath, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

test.use({ trace: "off", viewport: { width: 1440, height: 900 } });

const TABLE = ["| Item | Note |", "| ---- | ---- |", "| one  | a    |", "| two  | b    |"].join(
	"\n",
);

/** A Chat beside the document, so that a restyle of the whole page is many times one of the prose. */
function transcript(): Chat.Entry[] {
	return Array.from({ length: 60 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: ["ana", "bo"][index % 2]! },
		text: `Message ${index} about the rollout, and what it still needs from each team.`,
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

/** The most elements one style recalculation touched on `page` while `act` ran. */
async function largestRestyle(page: Page, act: () => Promise<void>): Promise<number> {
	let browser = page.context().browser()!;
	await browser.startTracing(page, { categories: ["devtools.timeline"] });
	await act();
	await settle(page);
	let trace = JSON.parse((await browser.stopTracing()).toString()) as {
		traceEvents: { name: string; args?: { elementCount?: number } }[];
	};
	let restyled = trace.traceEvents
		.filter(event => event.name === "UpdateLayoutTree")
		.map(event => event.args?.elementCount ?? 0);
	expect(restyled.length).toBeGreaterThan(0);
	return Math.max(...restyled);
}

test("a collaborator starting paragraphs and typing in a table restyles what they changed", async ({ baseURL, join, playwright, room, seed }) => {
	await seed(`# Restyles\n\nA paragraph to start from.\n\n${TABLE}\n\nThe end.\n`, {
		transcript: transcript(),
	});
	let ana = await join("ana");
	// Bo is in a browser of his own, so that the trace of Ana's page holds no work of his.
	let other = await playwright.chromium.launch();
	try {
		let bo = await (await other.newContext({ baseURL })).newPage();
		await authenticate(bo, "bo", baseURL!);
		await bo.goto(roomPath(room));
		await ready(bo);
		let region = ana.getByRole("region", { name: "Document" });

		// Bo's caret appears once, and its first appearance colours the page for him.
		await content(bo).getByText("A paragraph to start from.").click();
		await bo.keyboard.press("End");
		await expect(region.getByText("bo", { exact: true })).toBeAttached();
		await settle(ana);
		let elements = await ana.evaluate(() => document.querySelectorAll("*").length);

		let largest = await largestRestyle(ana, async () => {
			for (let line = 1; line <= 3; line++) {
				await bo.keyboard.press("Enter");
				await bo.keyboard.type(`Line ${line}.`, { delay: 20 });
			}
			await content(bo).getByRole("cell", { name: "a", exact: true }).click();
			await bo.keyboard.press("End");
			await bo.keyboard.type(" and more", { delay: 20 });
			await bo.keyboard.press("Enter");
			await bo.keyboard.type("A second line.", { delay: 20 });
			await expect(content(ana)).toContainText("A second line.");
		});
		// Bo's caret arrives before the paragraph or cell it is in. Lexical dropped it and drew it
		// again when the edit landed, rewriting the stylesheet that colours his selection each time,
		// and the browser restyled every element on Ana's page for that: on a long document, most of
		// a second.
		expect(largest).toBeLessThan(elements / 2);
	} finally {
		await other.close();
	}
});

test("a key typed with nothing in the margin measures no margin", async ({ join, seed }) => {
	await seed("# Margins\n\nA paragraph to type into.\n\nAnother paragraph below it.\n");
	let ana = await join("ana");
	// Count geometry read from the document's frame, which both margins measure against.
	await ana.evaluate(() => {
		let reads = 0;
		for (let name of ["getBoundingClientRect", "getClientRects"] as const) {
			let read = Element.prototype[name] as (this: Element) => unknown;
			Object.defineProperty(Element.prototype, name, {
				configurable: true,
				value(this: Element) {
					if (this.classList.contains("plan-document")) reads++;
					return read.call(this);
				},
			});
		}
		Object.defineProperty(window, "__marginReads", { get: () => reads });
	});
	await content(ana).getByText("A paragraph to type into.").click();
	await ana.keyboard.press("End");
	await settle(ana);
	let before = await ana.evaluate(() =>
		(window as unknown as { __marginReads: number }).__marginReads
	);
	await ana.keyboard.type(" Twelve keys.", { delay: 20 });
	await expect(content(ana)).toContainText("Twelve keys.");
	await settle(ana);
	let after = await ana.evaluate(() =>
		(window as unknown as { __marginReads: number }).__marginReads
	);
	// The comment margin and the resolved-decision margin each read it on every edit, with nothing
	// to place, and each read made the browser lay the page out there and then.
	expect(after - before).toBe(0);
});
