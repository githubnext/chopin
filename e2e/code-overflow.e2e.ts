/**
 * A fenced block asks the stylesheet whether to wrap or scroll its lines, and asks where the page's
 * layout is current.
 *
 * The answer is a custom property, and a container query decides it, so reading it makes the
 * browser lay the page out. Read in the commit that mounts a block, each block's read came after
 * the previous block's coloured copy was written, and every one laid the whole document out again:
 * forty blocks, about twenty layouts, most of a second in all. A ResizeObserver's callback runs
 * after the frame's own layout, so a read there costs nothing, and until it has answered a block
 * draws nothing, so a phone never paints scrolling lines and then wraps them.
 *
 * Code in a named language is coloured in place and has no drawn copy; a diff fence still has one,
 * so these blocks are diffs (half of them not patches, drawn as the text they are).
 */

import { content, expect, test } from "./room";

// A long document is laid out again for the trace's snapshots; see pane-drag-skip.e2e.ts.
test.use({ trace: "off" });

const BLOCKS = 40;
const FENCES = Array.from(
	{ length: BLOCKS },
	(_, index) =>
		`Block ${index}.\n\n\`\`\`diff\n${
			index % 2
				? `--- a/block_${index}.rs\n+++ b/block_${index}.rs\n@@ -1 +1 @@\n-fn block_${index}() {}\n+fn block_${index}() -> usize { ${index} }`
				: `- Feature: block ${index}\n+ Feature: block ${index}, read`
		}\n\`\`\`\n\n`,
).join("");

test("a fenced block reads the stylesheet's wrap switch only where layout is current", async ({ join, page, seed }) => {
	await seed(`# Many blocks\n\n${FENCES}The end.\n`);
	await page.setViewportSize({ width: 1440, height: 900 });
	// Every read of the switch, and whether it was made inside a ResizeObserver callback, which the
	// browser runs after it has laid the frame out.
	await page.addInitScript(() => {
		let inside = 0;
		let reads: boolean[] = [];
		Object.defineProperty(window, "__overflowReads", { get: () => reads });
		let Native = window.ResizeObserver;
		window.ResizeObserver = class extends Native {
			constructor(callback: ResizeObserverCallback) {
				super((entries, observer) => {
					inside++;
					try {
						callback(entries, observer);
					} finally {
						inside--;
					}
				});
			}
		};
		let read = window.getComputedStyle.bind(window);
		window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
			if (element.classList?.contains("plan-code-view")) reads.push(inside > 0);
			return read(element, pseudo);
		}) as typeof window.getComputedStyle;
	});
	await join("ana");
	let views = content(page).getByRole("group", { name: "Diff preview", exact: true });
	await expect(views).toHaveCount(BLOCKS);
	// Every block has been answered and drawn: the renderer's own box carries the answer.
	await expect(content(page).locator("pre[data-overflow='scroll']")).toHaveCount(BLOCKS, {
		timeout: 20_000,
	});
	let reads = await page.evaluate(() =>
		(window as unknown as { __overflowReads: boolean[] }).__overflowReads
	);
	expect(reads.length, "reads of the wrap switch").toBeGreaterThanOrEqual(BLOCKS);
	expect(
		reads.filter(inside => !inside).length,
		"reads made outside a ResizeObserver callback, where each one lays the page out again",
	).toBe(0);
});
