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

import { content, expect, openIsolatedRoom, test } from "./room";
import { expectFocusIndicator } from "./focus";
import { installPointerMedia } from "./pointer-media";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

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

const WIDE_TABLE_HEADERS = [
	"Product",
	"Constraint",
	"Surface",
	"Signal",
	"Source",
	"Preview",
	"Scrollbar",
	"Measure",
	"Owner",
	"Status",
	"Priority",
	"Target",
	"Risk",
	"Notes",
];

const WIDE_TABLE = [
	`| ${WIDE_TABLE_HEADERS.join(" | ")} |`,
	`| ${WIDE_TABLE_HEADERS.map(() => "---").join(" | ")} |`,
	"| Chopin | Responsive | Document | Clear | Lexical | Rendered | Widget | Readable | "
	+ "Editor | Active | High | Desktop | Low | Stable |",
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

async function touchToolbar(page: Page, cell: Locator = content(page).locator("td").first()) {
	await cell.tap();
	let toolbar = page.getByRole("toolbar", { name: "Table actions" });
	await expect(toolbar).toBeVisible();
	return toolbar;
}

async function openGroup(toolbar: Locator, name: "Add" | "Remove" | "Move") {
	let trigger = toolbar.getByRole("button", { name, exact: true });
	await expectInsideViewport(trigger);
	await trigger.click();
	let group = toolbar.getByRole("group", { name: `${name} table actions` });
	await expect(group).toBeVisible();
	await expectInsideViewport(group.getByRole("button"));
	return group;
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

	await expect(page.locator("[data-plan-rail]")).toHaveCount(0);

	await content(page).locator("td").first().hover();

	await expect(page.locator('[data-plan-rail="row"]')).toBeVisible();
	await expect(page.locator('[data-plan-rail="column"]')).toBeVisible();
});

test("a wide table scrolls without losing its measured column rail", async ({ join, seed }) => {
	await seed(WIDE_TABLE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let table = content(page).locator("table");

	expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
	expect((await table.locator("th").first().boundingBox())!.width).toBeGreaterThanOrEqual(112);
	await content(page).locator("td").first().hover();
	let rail = page.locator('[data-plan-rail="column"]');
	await expect(rail).toBeVisible();
	await table.evaluate(node => {
		node.scrollLeft = 160;
	});
	await page.waitForTimeout(32);
	let cell = (await table.locator("th").nth(4).boundingBox())!;
	let gripBox = (await grip(rail, "column", 5).boundingBox())!;
	expect(Math.abs(cell.x + cell.width / 2 - (gripBox.x + gripBox.width / 2))).toBeLessThan(2);
	await expectNoHorizontalOverflow(page);
});

test("the header row is drawn a bar, not a grip", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana");
	let rail = await rails(page);

	// A bar and not a gap: a rail with a hole where a row plainly is reads as
	// a bug, so the header is drawn and simply cannot be taken hold of.
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
	await page.keyboard.press("Tab");
	let rowGrip = grip(rail, "row", 2);
	await rowGrip.focus();
	await expectFocusIndicator(rowGrip);
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

test("touch table action groups are labelled, reachable, and clear of the selected cell", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});

	let cell = content(page).locator("td").last();
	await cell.evaluate(element => element.scrollIntoView({ block: "end" }));
	let toolbar = await touchToolbar(page, cell);
	let access = [
		toolbar.getByRole("button", { name: "Add", exact: true }),
		toolbar.getByRole("button", { name: "Remove", exact: true }),
		toolbar.getByRole("button", { name: "Move", exact: true }),
		toolbar.getByRole("button", { name: /^Align column 2/ }),
	];
	for (let button of access) await expectInsideViewport(button);
	let targets = await Promise.all(access.map(button =>
		button.evaluate(node => {
			let box = node.getBoundingClientRect();
			return { height: box.height, width: box.width };
		})
	));
	expect(targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
	await expectInsideViewport(toolbar);
	let add = await openGroup(toolbar, "Add");
	let cellBox = await cell.boundingBox();
	let toolbarBox = await toolbar.boundingBox();
	expect(cellBox).not.toBeNull();
	expect(toolbarBox).not.toBeNull();
	expect(cellBox!.y + cellBox!.height).toBeLessThanOrEqual(toolbarBox!.y - 8);
	let actionTargets = await add.getByRole("button").evaluateAll(buttons =>
		buttons.map(button => button.getBoundingClientRect().height)
	);
	expect(actionTargets.every(height => height >= 44)).toBe(true);
	await openGroup(toolbar, "Remove");
	await openGroup(toolbar, "Move");
	await expect(page.locator("[data-plan-rail]")).not.toBeVisible();
});

test("a compact fine-pointer table keeps drag grips and actions reachable", async ({ join, seed }) => {
	await seed(WIDE_TABLE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let cell = content(page).locator("td").first();
	await cell.click();

	let toolbar = page.getByRole("toolbar", { name: "Table actions" });
	await expect(toolbar).toBeVisible();
	await expectInsideViewport(toolbar);
	let rowRail = page.locator('[data-plan-rail="row"]');
	let columnRail = page.locator('[data-plan-rail="column"]');
	await expect(rowRail).toBeVisible();
	await expect(columnRail).toBeVisible();
	let rowGrip = grip(rowRail, "row", 2);
	let columnGrip = grip(columnRail, "column", 1);
	await expectInsideViewport(rowGrip);
	await expectInsideViewport(columnGrip);
	let rowRailBox = (await rowRail.boundingBox())!;
	let rowGripBox = (await rowGrip.boundingBox())!;
	let columnRailBox = (await columnRail.boundingBox())!;
	let columnGripBox = (await columnGrip.boundingBox())!;
	expect(rowRailBox.width).toBe(rowGripBox.width);
	expect(columnRailBox.height).toBe(columnGripBox.height);
	await expect(page.locator(".plan-grip-remove:visible, .plan-insert:visible, .plan-align:visible"))
		.toHaveCount(0);
	let controls = toolbar.getByRole("button");
	let targets = await controls.evaluateAll(buttons =>
		buttons.map(button => {
			let box = button.getBoundingClientRect();
			return { height: box.height, width: box.width };
		})
	);
	expect(targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
	await controls.first().focus();
	await expect(controls.first()).toBeFocused();
	await expectInsideViewport(controls);
	await expectNoHorizontalOverflow(page);
});

test("a compact fine-pointer grip still drags a row", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let rowRail = await rails(page);
	let held = grip(rowRail, "row", 2);
	let from = (await held.boundingBox())!;
	let table = (await content(page).locator("table").boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + from.width / 2, table.y + table.height + 8);
	await page.mouse.up();

	await expect(items(page)).toHaveText(["two", "three", "one"]);
	await expectNoHorizontalOverflow(page);
});

test("a hybrid desktop exposes touch table actions and desktop rails", async ({ baseURL, browser, room, seed }) => {
	await seed(TABLE);
	let roomPage = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"ana",
		{ hasTouch: true, viewport: { width: 1440, height: 900 } },
		context => installPointerMedia(context, { coarse: true, primaryCoarse: false }),
	);
	try {
		let page = roomPage.page;
		await expect.poll(() =>
			page.evaluate(() => ({
				anyCoarse: matchMedia("(any-pointer: coarse)").matches,
				primaryFine: matchMedia("(pointer: fine)").matches,
			}))
		).toEqual({ anyCoarse: true, primaryFine: true });

		let cell = content(page).getByRole("cell", { name: "one" });
		await cell.tap();
		let toolbar = page.getByRole("toolbar", { name: "Table actions" });
		await expect(toolbar).toBeVisible();
		await expect(toolbar.getByRole("button", { name: "Add", exact: true })).toBeVisible();
		let rail = await rails(page);
		await expect(rail.getByRole("button", { name: "Move row 2", exact: true })).toBeVisible();
	} finally {
		await roomPage.close();
	}
});

test("touch row actions add, remove, and move the selected row", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let toolbar = await touchToolbar(page);
	let move = await openGroup(toolbar, "Move");
	await move.getByRole("button", { name: "Move row down" }).click();
	await expect(items(page)).toHaveText(["two", "one", "three"]);
	let add = await openGroup(toolbar, "Add");
	await add.getByRole("button", { name: "Add row after" }).click();
	await expect(items(page)).toHaveCount(4);
	let remove = await openGroup(toolbar, "Remove");
	await remove.getByRole("button", { name: /^Remove row / }).click();
	await expect(items(page)).toHaveCount(3);
});

test("touch column actions add, remove, move, and align the selected column", async ({ join, seed }) => {
	await seed(TABLE);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let toolbar = await touchToolbar(page);
	let align = toolbar.getByRole("button", { name: /^Align column 1/ });
	await align.click();
	await expect(align).toHaveAccessibleName(/currently left/);
	await align.click();
	await expect(align).toHaveAccessibleName(/currently centre/);

	let move = await openGroup(toolbar, "Move");
	await move.getByRole("button", { name: "Move column right" }).click();
	await expect(content(page).locator("th")).toHaveText(["Note", "Item"]);

	toolbar = await touchToolbar(page, content(page).locator("td").last());
	let add = await openGroup(toolbar, "Add");
	await add.getByRole("button", { name: "Add column after" }).click();
	await expect(content(page).locator("th")).toHaveCount(3);
	let remove = await openGroup(toolbar, "Remove");
	await remove.getByRole("button", { name: /^Remove column / }).click();
	await expect(content(page).locator("th")).toHaveCount(2);
});

test("touch table guards disable header, last-column, and row-limit actions", async ({ join, seed }) => {
	let rows = Array.from({ length: 99 }, (_, index) => `| r${index} |`);
	await seed(["| Item |", "| ---- |", ...rows, ""].join("\n"));
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let toolbar = await touchToolbar(page, content(page).locator("th").first());
	let add = await openGroup(toolbar, "Add");
	await expect(add.getByRole("button", { name: "Add row before" })).toBeDisabled();
	await expect(add.getByRole("button", { name: "Add row after" })).toBeDisabled();
	let remove = await openGroup(toolbar, "Remove");
	await expect(remove.getByRole("button", { name: /^Remove row / })).toBeDisabled();
	await expect(remove.getByRole("button", { name: /^Remove column / })).toBeDisabled();
	let move = await openGroup(toolbar, "Move");
	await expect(move.getByRole("button", { name: "Move row down" })).toBeDisabled();
	await expect(move.getByRole("button", { name: "Move column right" })).toBeDisabled();
});
