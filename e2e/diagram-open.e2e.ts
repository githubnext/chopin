/**
 * A document with many SeeCode diagrams opens with the page laid out a handful of times, not once
 * per diagram.
 *
 * Each diagram measures its column when it mounts, before the first paint, to know whether it fits
 * and whether to offer zoom controls. The measure is a read of layout, and the diagram's own state
 * writes (the classes that show its steps) come right after it, so the next diagram's read had to
 * lay the page out again: a document of sixty diagrams took about a layout and a quarter for each
 * on top of the thirty-odd the page makes anyway. The count of layouts is the browser's own
 * (`LayoutCount`), so the test does not depend on how fast the machine is.
 */

import { DIAGRAM_FIXTURES } from "../packages/diagrams/src/fixtures";
import { content, expect, test } from "./room";

import type { CDPSession, Page } from "@playwright/test";

// A long document is laid out again for the trace's snapshots; see pane-drag-skip.e2e.ts.
test.use({ trace: "off" });

/** Wider than the column, and with a layout of its own a compact one cannot replace. */
let fixed = DIAGRAM_FIXTURES.find(entry => entry.type === "swimlane")!.spec;
/** Wider than the column until the page draws it again, compact, for the column it has. */
let compactable = {
	type: "architecture",
	nodes: [
		{ id: "project", label: "Project", row: 0, col: 0 },
		{ id: "cli", label: "CLI", row: 0, col: 1 },
		{ id: "deps", label: "Dependencies", row: 1, col: 1 },
		{ id: "builder", label: "Builder", row: 0, col: 2 },
		{ id: "dist", label: "Output", row: 0, col: 3 },
		{ id: "release", label: "Release", row: 1, col: 3 },
	],
	edges: [
		["project", "cli", "installs"],
		["cli", "deps", "requires"],
		["builder", "cli", "runs"],
		["builder", "dist", "produces"],
		["release", "dist", "copies"],
	],
};
let narrow = {
	type: "architecture",
	nodes: [{ id: "a", label: "Caller", row: 0, col: 0 }, {
		id: "b",
		label: "Callee",
		row: 0,
		col: 1,
	}],
	edges: [["a", "b", "calls"]],
};
const fence = (spec: unknown) => `\`\`\`seecode\n${JSON.stringify(spec)}\n\`\`\``;
const DIAGRAMS = 60;
/** Odd places fit their column; the others are wider, and the third of four stays wide. */
const KINDS = [compactable, narrow, fixed, narrow];
const SOURCE = `# Many diagrams\n\n${
	Array.from(
		{ length: DIAGRAMS },
		(_, index) => `Between diagram ${index}.\n\n${fence(KINDS[index % 4])}\n\n`,
	).join("")
}The end.\n`;

async function layouts(cdp: CDPSession): Promise<number> {
	let { metrics } = await cdp.send("Performance.getMetrics");
	return metrics.find(metric => metric.name === "LayoutCount")!.value;
}

/** Wait until the page has stopped laying itself out: the count the same for a while. */
async function settled(page: Page, cdp: CDPSession): Promise<number> {
	let last = -1;
	let still = 0;
	for (let tries = 0; tries < 100 && still < 5; tries++) {
		await page.waitForTimeout(200);
		let now = await layouts(cdp);
		still = now === last ? still + 1 : 0;
		last = now;
	}
	return last;
}

test("opening a document of sixty diagrams lays the page out fewer times than it has diagrams", async ({ join, page, seed }) => {
	await seed(SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	// Nothing plays, so what is counted is the opening and not an entrance animation's steps.
	await page.emulateMedia({ reducedMotion: "reduce" });
	let cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	await join("ana");
	let previews = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	await expect(previews).toHaveCount(DIAGRAMS);
	for (let index of [0, DIAGRAMS - 1]) {
		await expect(previews.nth(index).locator("svg.sc-svg")).toBeAttached();
	}
	let total = await settled(page, cdp);
	expect(total, "layouts from the first byte to a settled page").toBeLessThan(DIAGRAMS);
});

test("a diagram that fits its column is never shown with zoom controls, on any frame", async ({ join, page, seed }) => {
	await seed(SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	// Every frame's view of the diagrams: a diagram that fits has nothing to zoom, so a frame that
	// offers zoom controls over one is a flash of controls the measure takes away a frame later.
	await page.addInitScript(() => {
		let offered = new Set<number>();
		Object.defineProperty(window, "__zoomOffered", { get: () => [...offered] });
		let sample = () => {
			document.querySelectorAll(".plan-seecode").forEach((preview, index) => {
				if (index % 2 && preview.querySelector('[aria-label="Zoom in diagram"]')) {
					offered.add(index);
				}
			});
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});
	await join("ana");
	let previews = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	await expect(previews).toHaveCount(DIAGRAMS);
	await expect(previews.nth(DIAGRAMS - 1).locator("svg.sc-svg")).toBeAttached();
	await page.waitForTimeout(1_000);
	// The one that stays wider than its column, measured, offers them: the measure ran.
	await expect(previews.nth(2).getByRole("button", { name: "Zoom in diagram" })).toBeAttached();
	let offered = await page.evaluate(() =>
		(window as unknown as { __zoomOffered: number[] }).__zoomOffered
	);
	expect(offered, "narrow diagrams that were offered zoom controls on some frame").toEqual([]);
});
