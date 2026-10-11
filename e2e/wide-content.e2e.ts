/**
 * Wide authored blocks on a phone-width document.
 *
 * A table keeps its own scroll lane and fades whichever side still hides
 * columns; code wraps instead of scrolling a few characters at a time; a
 * diagram too dense for the measure opens full screen. A wide document keeps
 * all three as they were.
 */

import { content, expect, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const TABLE = `| Case | Today | After | Owner | Risk | Verification |
| --- | --- | --- | --- | --- | --- |
| Short drop | Edits kept in memory | Same | Client | Low | Unit test for the queue |
| Tab closed offline | Edits lost | Replayed on next open | Client | Medium | Browser test |
`;

const CODE = `\`\`\`typescript
export async function replayPending(socket: PlanSocket, pending: Pending, current: string): Promise<"replayed" | "conflict"> {
	return pending.epoch === current ? "replayed" : "conflict";
}
\`\`\`
`;

const DIAGRAM = `\`\`\`mermaid
flowchart LR
	A[Compact document measure that readers can track] --> B[Independent widget scrollers that preserve the document width]
	B --> C[Keyboard-safe destination switching across responsive workspaces]
	C --> D[Durable agent change chips and collaborator cursor labels]
\`\`\`
`;

function mask(table: Locator): Promise<string> {
	return table.evaluate(node => getComputedStyle(node).maskImage);
}

test("a wide table fades only the sides that still hide columns", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", { viewport: PHONE });
	let table = content(page).locator("table");

	await expect(table).toHaveAttribute("data-more", "end");
	await expect.poll(() => mask(table)).toContain("gradient");

	await table.evaluate(node => (node.scrollLeft = 40));
	await expect(table).toHaveAttribute("data-more", "both");

	await table.evaluate(node => (node.scrollLeft = node.scrollWidth));
	await expect(table).toHaveAttribute("data-more", "start");

	await table.evaluate(node => (node.scrollLeft = 0));
	await expect(table).toHaveAttribute("data-more", "end");
	await expectNoHorizontalOverflow(page);

	// A wide document keeps its table unfaded.
	await page.setViewportSize(DESKTOP);
	await expect.poll(() => mask(table)).toBe("none");
});

test("code wraps at phone width and scrolls on a wide document", async ({ join, seed }) => {
	await seed(CODE);
	let page = await join("ana", { viewport: PHONE });
	let view = content(page).locator("[data-plan-preview] .plan-code-view");
	await expect(view.locator("[data-file]")).toBeVisible();

	await expect.poll(() => view.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
	await expect(view.locator("pre[data-overflow='wrap']")).toBeAttached();

	// The source wraps too while someone is editing it.
	await content(page).getByRole("button", { name: "Show source" }).click();
	let source = content(page).locator("[data-plan-source]");
	await expect(source).toBeVisible();
	expect(await source.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
	await expectNoHorizontalOverflow(page);

	await page.setViewportSize(DESKTOP);
	await expect(view.locator("pre[data-overflow='scroll']")).toBeAttached();
	await expect.poll(() => view.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
});

test("a dense diagram opens full screen and closes", async ({ join, seed }) => {
	await seed(DIAGRAM);
	let page = await join("ana", { viewport: PHONE });
	let expand = content(page).getByRole("button", { name: "Expand diagram" });
	await expect(expand).toBeVisible();
	let box = await expand.boundingBox();
	expect(box?.width).toBeGreaterThanOrEqual(44);
	expect(box?.height).toBeGreaterThanOrEqual(44);

	await expand.click();
	let sheet = page.getByRole("dialog", { name: "Diagram" });
	await expect(sheet).toBeVisible();
	let close = sheet.getByRole("button", { name: "Close diagram" });
	await expect(close).toBeFocused();
	await expect(sheet.locator("svg")).toBeVisible();

	// At its authored size the drawing pans in its own scroller; fitting it
	// shows the whole shape. Which it opens in depends on how wide it is.
	let scroller = sheet.getByRole("region", { name: "Diagram, scroll to pan" });
	let zoom = sheet.getByRole("button", { name: "Zoom in diagram" });
	if (await zoom.isVisible()) await zoom.click();
	await expect.poll(() => scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(
		true,
	);
	await sheet.getByRole("button", { name: "Fit diagram to screen" }).click();
	await expect.poll(() => scroller.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(
		true,
	);

	// Focus cycles inside the sheet rather than leaving it.
	await close.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(scroller).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(sheet.getByRole("button", { name: "Zoom in diagram" })).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();

	await expand.click();
	await expect(sheet).toBeVisible();
	await close.click();
	await expect(sheet).toBeHidden();
	await expectNoHorizontalOverflow(page);

	// A wide document keeps the scroll lane and has no full-screen control.
	await page.setViewportSize(DESKTOP);
	await expect(expand).toBeHidden();
});
