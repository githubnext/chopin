/**
 * Wide authored blocks on a phone.
 *
 * A table keeps its own scroll lane and fades whichever side still hides
 * columns; code wraps instead of scrolling a few characters at a time; a
 * diagram too dense for the measure opens full screen. The phone class is a
 * coarse pointer on a small screen, so a narrow desktop window with Chat open
 * keeps all three exactly as they were.
 */

import { content, expect, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { Locator } from "@playwright/test";

const PHONE = { hasTouch: true, viewport: { width: 390, height: 844 } };
/** Chat open beside a document narrower than 40rem, with a fine pointer. */
const NARROW_DESKTOP = { viewport: { width: 1280, height: 800 } };

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

/** A left-to-right flowchart of ten steps, far wider than any document's measure. */
const FLOW = `\`\`\`mermaid
flowchart LR
	A[Draft the document] --> B[Review the plan] --> C[Ask the decisions] --> D[Answer them]
	D --> E[Break it into tasks] --> F[Build plan] --> G[Open pull requests]
	G --> H[Verify every task] --> I[Merge] --> J[Ship it to everyone]
\`\`\`
`;

/** Where the frame, its drawing and the drawing's first and last steps are on screen. */
function frame(region: Locator) {
	return region.evaluate(element => {
		let box = element.getBoundingClientRect();
		let svg = element.querySelector("svg")!.getBoundingClientRect();
		let steps = [...element.querySelectorAll(".node")].map(node => node.getBoundingClientRect())
			.sort((a, b) => a.left - b.left);
		let shown = (step: DOMRect) => step.left >= box.left - 1 && step.right <= box.right + 1;
		return {
			scrolls: element.scrollWidth > element.clientWidth + 1,
			fits: svg.right <= box.right + 1,
			first: shown(steps[0]!),
			last: shown(steps.at(-1)!),
			drawn: svg.height,
			height: box.height,
		};
	});
}

function mask(table: Locator): Promise<string> {
	return table.evaluate(node => getComputedStyle(node).maskImage);
}

test("a wide table fades only the sides that still hide columns", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", PHONE);
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

	// Editing a cell can give the table a new element; the fade must follow it. Phones open
	// documents for reading, so the writer switches to editing first.
	await page.getByRole("button", { name: "Edit document" }).tap();
	await content(page).getByRole("cell", { name: "Same" }).click();
	await page.keyboard.type(" as before, with a longer explanation");
	await expect(content(page).getByRole("cell", { name: /longer explanation/ })).toBeVisible();
	await table.evaluate(node => (node.scrollLeft = node.scrollWidth));
	await expect(table).toHaveAttribute("data-more", "start");
	await table.evaluate(node => (node.scrollLeft = 0));
	await expect(table).toHaveAttribute("data-more", "end");
});

test("code wraps on a phone and keeps one preview when it stops", async ({ join, seed }) => {
	await seed(CODE);
	let page = await join("ana", PHONE);
	let view = content(page).getByRole("group", { name: "Code preview" });
	await expect(view.locator("pre[data-overflow='wrap']")).toBeAttached();
	expect(await view.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);

	// The source wraps too while someone is editing it; phones edit from the pencil.
	await page.getByRole("button", { name: "Edit document" }).tap();
	// Editing puts the caret in the first block in view, which may already open this source.
	let show = content(page).getByRole("button", { name: "Show source" });
	let source = content(page).locator("[data-plan-source]");
	await expect(show.or(source).first()).toBeVisible();
	if (await show.isVisible()) await show.click();
	await expect(source).toBeVisible();
	expect(await source.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
	await expectNoHorizontalOverflow(page);
	await content(page).getByRole("button", { name: "Hide source" }).click();

	// Leaving the phone class switches the same preview back to scrolling;
	// it is never remounted, so one owner keeps the node.
	await view.evaluate(node => node.setAttribute("data-test-identity", ""));
	await page.setViewportSize({ width: 1024, height: 768 });
	await expect(view.locator("pre[data-overflow='scroll']")).toBeAttached();
	await expect(view).toHaveAttribute("data-test-identity", "");
});

test("a narrow desktop window keeps wide blocks as they were", async ({ join, seed }) => {
	await seed(`${TABLE}\n${CODE}\n${DIAGRAM}`);
	let page = await join("ana", NARROW_DESKTOP);
	let document = content(page);
	// The document is narrower than 40rem here; only the pointer differs from a phone.
	expect(
		await document.evaluate(node => node.closest(".plan-document")!.clientWidth),
	).toBeLessThan(640);

	let view = document.getByRole("group", { name: "Code preview" });
	await expect(view.locator("pre[data-overflow='scroll']")).toBeAttached();
	await expect.poll(() => view.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	await expect.poll(() => mask(document.locator("table"))).toBe("none");
	await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
	await expect(document.getByRole("button", { name: "Expand diagram" })).toHaveCount(0);
});

test("a dense diagram opens full screen at a readable size and closes", async ({ join, seed }) => {
	await seed(DIAGRAM);
	let page = await join("ana", PHONE);
	let region = content(page).getByRole("region", { name: "Diagram preview" });
	let expand = content(page).getByRole("button", { name: "Expand diagram" });
	await expect(expand).toBeVisible();

	// A row of its own under the scroll lane, never over the drawing.
	let [drawing, button] = await Promise.all([region.boundingBox(), expand.boundingBox()]);
	expect(button!.y).toBeGreaterThanOrEqual(drawing!.y + drawing!.height - 1);

	await expand.click();
	let sheet = page.getByRole("dialog", { name: "Diagram" });
	await expect(sheet).toBeVisible();
	let close = sheet.getByRole("button", { name: "Close diagram" });
	await expect(close).toBeFocused();

	// Fitting this one would shrink it past legibility, so it opens at its
	// authored size and pans in its own scroller; Fit shows the whole shape.
	let scroller = sheet.getByRole("region", { name: "Diagram, scroll to pan" });
	let fit = sheet.getByRole("button", { name: "Fit diagram to screen" });
	await expect(fit).toBeVisible();
	expect(await scroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	await fit.click();
	await expect.poll(() => scroller.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(
		true,
	);
	let actual = sheet.getByRole("button", { name: "Actual size" });
	await expect(actual).toBeVisible();

	// Focus cycles inside the sheet rather than leaving it.
	await close.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(scroller).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(actual).toBeFocused();

	// Escape closes it and returns focus to the control that opened it.
	await page.keyboard.press("Escape");
	await expect(sheet).toBeHidden();
	await expect(expand).toBeFocused();

	// So does a tap on Close, though the tap never focused the button.
	await expand.evaluate(node => (node as HTMLElement).blur());
	await expand.tap();
	await expect(sheet).toBeVisible();
	await close.tap();
	await expect(sheet).toBeHidden();
	await expect(expand).toBeFocused();
	await expectNoHorizontalOverflow(page);
});

for (let width of [1280, 1920]) {
	test(`a wide flowchart starts at its first step and fits the frame on request at ${width}px`, async ({ join, seed }) => {
		await seed(`# Delivery\n\nHow a document becomes pull requests.\n\n${FLOW}\nThen it ships.\n`);
		let page = await join("ana", { viewport: { width, height: 900 } });
		let region = content(page).getByRole("region", { name: "Diagram preview" });
		await expect(region).toBeVisible();
		let fit = content(page).getByRole("button", { name: "Fit diagram to width" });

		// Too wide to read at the measure: its first screen is its start, and the frame says so.
		await expect(fit).toBeVisible();
		let shown = await frame(region);
		expect(shown).toMatchObject({ scrolls: true, first: true, last: false });
		await expect(region).toHaveAttribute("data-more", "end");

		// Fitted, the whole shape is in the frame, with no band above or below it.
		await fit.click();
		await expect.poll(async () => (await frame(region)).fits).toBe(true);
		let fitted = await frame(region);
		expect(fitted).toMatchObject({ scrolls: false, first: true, last: true });
		expect(fitted.drawn).toBeLessThan(shown.drawn);
		await expect(region).not.toHaveAttribute("data-more");

		// Actual size scrolls again, from its start.
		await content(page).getByRole("button", { name: "Actual size" }).click();
		await expect.poll(async () => (await frame(region)).scrolls).toBe(true);
		expect(await frame(region)).toMatchObject({ first: true, last: false });
		await expect(fit).toBeVisible();
		await expectNoHorizontalOverflow(page);
	});
}

test("a wide flowchart on a phone starts at its first step and offers its full-screen reading", async ({ join, seed }) => {
	await seed(`# Delivery\n\nHow a document becomes pull requests.\n\n${FLOW}\nThen it ships.\n`);
	let page = await join("ana", PHONE);
	let region = content(page).getByRole("region", { name: "Diagram preview" });
	await expect(region).toBeVisible();
	await expect(content(page).getByRole("button", { name: "Expand diagram" })).toBeVisible();
	await expect(content(page).getByRole("button", { name: "Fit diagram to width" })).toHaveCount(0);
	expect(await frame(region)).toMatchObject({ scrolls: true, first: true, last: false });
	await expect(region).toHaveAttribute("data-more", "end");
	// A swipe reaches its last step.
	await region.evaluate(node => (node.scrollLeft = node.scrollWidth));
	await expect.poll(async () => (await frame(region)).last).toBe(true);
	await expectNoHorizontalOverflow(page);
});
