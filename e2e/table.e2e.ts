/**
 * The rails, which cannot be tested any other way.
 *
 * `geometry.ts`, `ops.ts` and `shape.ts` are covered by `bun test` because
 * they were deliberately kept free of the document. What is left here is the
 * part that measures cell rectangles and turns a pointer into a reorder, and
 * measurement needs layout: happy-dom returns zero for every rectangle, which
 * makes a rail drawn in the right place and one drawn on top of itself
 * indistinguishable.
 *
 * The rails are also where the header row's furniture-not-a-row rule is
 * actually visible. A header that could be dragged would not reorder the table
 * so much as change what it claims, and the only place that rule exists is in
 * which elements get rendered.
 */

import { content, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

/** Header plus three body rows, each nameable. */
const TABLE = [
	"| Item  | Note |",
	"| ----- | ---- |",
	"| one   | a    |",
	"| two   | b    |",
	"| three | c    |",
	"",
].join("\n");

/** Raise the rails the way a reader does, and hand back the row one. */
async function rails(page: Page): Promise<Locator> {
	await content(page).locator("td").first().hover();
	let rail = page.locator('[data-plan-rail="row"]');
	await expect(rail).toBeVisible();
	return rail;
}

/**
 * The first cell of every body row, in document order.
 *
 * No `tbody` in the selector: Lexical builds the table by appending rows to the
 * element itself, and the section browsers insert while parsing HTML is not
 * inserted for a tree that was constructed. A header cell is a `th`, so `td`
 * alone is already "body row".
 */
function items(page: Page): Locator {
	return content(page).locator("tr > td:first-child");
}

/**
 * A grip, addressed exactly.
 *
 * "Remove row 4" contains "Move row 4", and an accessible name matches as a
 * substring unless it is told not to — so the obvious locator resolves to the
 * grip *and* the remove button beside it, and refuses to act on either.
 */
function grip(rail: Locator, axis: "row" | "column", index: number): Locator {
	return rail.getByRole("button", { name: `Move ${axis} ${index}`, exact: true });
}

test("hovering a table raises rails on both axes", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");

	await expect(page.locator(".plan-rail")).toHaveCount(0);

	await content(page).locator("td").first().hover();

	await expect(page.locator('[data-plan-rail="row"]')).toBeVisible();
	await expect(page.locator('[data-plan-rail="column"]')).toBeVisible();
});

test("the header row is drawn a bar, not a grip", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	// A bar and not a gap: a rail with a hole where a row plainly is reads as
	// a bug, so the header is drawn and simply cannot be taken hold of.
	await expect(rail.locator(".plan-grip.is-fixed")).toHaveCount(1);
	await expect(rail.getByRole("button", { name: "Move row 1" })).toHaveCount(0);
	await expect(rail.getByRole("button", { name: "Remove row 1" })).toHaveCount(0);

	// Nor can anything be put above it. The first seam a row can use is the
	// one below the header.
	await expect(rail.getByRole("button", { name: "Insert row before the first" })).toHaveCount(0);
	await expect(rail.getByRole("button", { name: "Insert row after row 1" })).toBeAttached();

	// Every body row can be moved.
	await expect(rail.getByRole("button", { name: /^Move row / })).toHaveCount(3);
});

test("a grip moves its row from the keyboard", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	await expect(items(page)).toHaveText(["one", "two", "three"]);

	// A reorder that is only ever a drag is a reorder some people cannot
	// perform at all.
	await grip(rail, "row", 2).focus();
	await page.keyboard.press("Meta+ArrowDown");

	await expect(items(page)).toHaveText(["two", "one", "three"]);
});

test("a grip drags its row, and says where it will land", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	let held = grip(rail, "row", 2);
	let from = (await held.boundingBox())!;
	let table = (await content(page).locator("table").boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await expect(held).toHaveClass(/is-held/);

	// Past the bottom of the table: the nearest seam is then the last one, so
	// the destination cannot depend on where a row's midpoint happens to fall.
	await page.mouse.move(from.x + from.width / 2, table.y + table.height + 8);

	// Drawn on the seam the drop will use, because deciding it twice is how
	// the line ends up promising one thing and the drop doing another.
	await expect(page.locator(".plan-drop")).toBeVisible();

	await page.mouse.up();

	await expect(items(page)).toHaveText(["two", "three", "one"]);
	await expect(page.locator(".plan-drop")).toHaveCount(0);
});

test("a drag that ends where it started shows no destination and does not reorder", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	let box = (await grip(rail, "row", 2).boundingBox())!;

	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();

	// Either seam bounding the row is where it already is, so there is no
	// destination to indicate and the table should stay where it is.
	await expect(page.locator(".plan-drop")).toHaveCount(0);

	await page.mouse.up();
	await expect(items(page)).toHaveText(["one", "two", "three"]);
});

test("a row can be removed once its grip is pointed at", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	// The remove button has no pointer events until the track it belongs to is
	// the one under the pointer, so the grip has to be hovered first. Clicking
	// it cold waits for actionability until the test times out.
	await grip(rail, "row", 4).hover();
	await expect(rail.getByRole("button", { name: "Remove row 4" })).toHaveAttribute(
		"data-plan-shown",
		"",
	);
	await rail.getByRole("button", { name: "Remove row 4" }).click();

	await expect(items(page)).toHaveText(["one", "two"]);
});

test("the last body row can go, and the table survives it", async ({ join, seed }) => {
	// `| a |\n| - |\n` is well formed and round-trips, so refusing this would
	// make deleting the table the only way to empty it.
	await seed("| Item |\n| ---- |\n| one  |\n");
	let page = await join("ana");
	let rail = await rails(page);

	await grip(rail, "row", 2).hover();
	await rail.getByRole("button", { name: "Remove row 2" }).click();

	await expect(content(page).locator("table")).toHaveCount(1);
	await expect(content(page).locator("th")).toHaveCount(1);
	await expect(items(page)).toHaveCount(0);
});

test("a column's alignment cycles, and the last column cannot be removed", async ({ join, seed }) => {
	await seed("| Item |\n| ---- |\n| one  |\n");
	let page = await join("ana");

	await content(page).locator("td").first().hover();
	let rail = page.locator('[data-plan-rail="column"]');
	await expect(rail).toBeVisible();

	await grip(rail, "column", 1).hover();
	let align = rail.getByRole("button", { name: /^Align column 1/ });
	await expect(align).toHaveAttribute("data-plan-align", "default");

	await align.click();
	await expect(align).toHaveAttribute("data-plan-align", "left");

	// The alignment hangs off the header's cells, which is the other half of
	// why the header is not a row.
	await expect(rail.getByRole("button", { name: "Remove column 1" })).toHaveCount(0);
});

test("a table at its row limit offers nowhere to add another", async ({ join, seed }) => {
	// The limit counts the header, so this is exactly at it. Asked here rather
	// than at the server, because a table the server refuses costs everybody
	// in the room their undo and their cursors under a fresh epoch.
	let rows = Array.from({ length: 99 }, (_, index) => `| r${index} | x |`);
	await seed(["| Item | Note |", "| ---- | ---- |", ...rows, ""].join("\n"));

	let page = await join("ana");
	let rail = await rails(page);

	// Gone rather than disabled: the seam it would have inserted at does not
	// exist, so there is nothing for a greyed button to be about.
	await expect(rail.getByRole("button", { name: /^Insert row / })).toHaveCount(0);

	// The column rail is unaffected — the limits are per axis.
	await expect(
		page.locator('[data-plan-rail="column"]').getByRole("button", { name: /^Insert column / }),
	).not.toHaveCount(0);
});
