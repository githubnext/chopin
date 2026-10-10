/**
 * Undo and redo in a shared document.
 *
 * Each person undoes only their own edits. `packages/editor/src/history.test.ts`
 * covers which transactions are tracked; this covers the keyboard path, two
 * real peers, and the server accepting what an undo sends.
 */

import { storedAcceptedComment } from "../apps/server/src/testing/plan";
import { readSource } from "./database";
import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const UNDO = "ControlOrMeta+z";
const REDO = "ControlOrMeta+Shift+z";

/** Put the caret at the end of the paragraph that reads `text`. */
async function caretAfter(page: Page, text: string) {
	let paragraph = content(page).locator("p").filter({ hasText: text });
	await paragraph.click();
	await page.keyboard.press("End");
}

test("undo and redo reverse my own typing", async ({ join, room, seed }) => {
	await seed("Storage goes on disk.\n");
	let ana = await join("ana");

	await caretAfter(ana, "Storage goes on disk.");
	await ana.keyboard.type(" As MDX.");
	await expect(content(ana)).toContainText("Storage goes on disk. As MDX.");

	await ana.keyboard.press(UNDO);
	await expect(content(ana)).not.toContainText("As MDX.");
	await expect(content(ana)).toContainText("Storage goes on disk.");
	await written(ana, room, /^Storage goes on disk\.\s*$/);

	await ana.keyboard.press(REDO);
	await expect(content(ana)).toContainText("Storage goes on disk. As MDX.");
	await written(ana, room, "Storage goes on disk. As MDX.");
});

test("my undo leaves a peer's edit alone", async ({ join, room, seed }) => {
	await seed("Ana writes here.\n\nBo writes here.\n");
	let ana = await join("ana");
	let bo = await join("bo");

	await caretAfter(ana, "Ana writes here.");
	await ana.keyboard.type(" Mine.");
	await expect(content(bo)).toContainText("Ana writes here. Mine.");

	await caretAfter(bo, "Bo writes here.");
	await bo.keyboard.type(" Theirs.");
	await expect(content(ana)).toContainText("Bo writes here. Theirs.");

	await content(ana).locator("p").filter({ hasText: "Ana writes here." }).click();
	await ana.keyboard.press(UNDO);

	await expect(content(ana)).not.toContainText("Mine.");
	await expect(content(bo)).not.toContainText("Mine.");
	await expect(content(ana)).toContainText("Bo writes here. Theirs.");
	await expect(content(bo)).toContainText("Bo writes here. Theirs.");
	await written(ana, room, "Bo writes here. Theirs.");
});

test("undo past an accepted decision is accepted by the server", async ({ join, page, room, seed }) => {
	let quote = "Keep the pilot reversible.";
	// Comments are no longer accepted, but stored decisions still project into the plan.
	let stored = await storedAcceptedComment(`${quote}\n`, quote, {
		by: "ana",
		text: "Record this.",
	});
	await seed(stored.source, { threads: [stored.thread] });
	let resets = 0;
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string" && payload.includes('"kind":"plan:reset"')) resets++;
		}));
	let ana = await join("ana");

	await caretAfter(ana, quote);
	await ana.keyboard.press("Enter");
	await ana.keyboard.type("Fresh prose.");
	await written(ana, room, "Fresh prose.");
	await written(ana, room, "<Decision");
	let decision = ana.locator("[data-plan-comment-card]").filter({ hasText: "Record this." });
	await expect(decision).toBeVisible();

	await content(ana).locator("p").filter({ hasText: "Fresh prose." }).click();
	await ana.keyboard.press(UNDO);
	await ana.keyboard.press(UNDO);

	await expect(content(ana)).not.toContainText("Fresh prose.");
	await expect(decision).toBeVisible();
	await expect.poll(() => readSource(Number(new URL(ana.url()).port), room))
		.not.toContain("Fresh prose.");
	await written(ana, room, "<Decision");
	expect(resets).toBe(0);
});
