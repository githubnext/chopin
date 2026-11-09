/**
 * A drawn Mermaid diagram, and a formula, are markup set as the inner HTML of their block. Every
 * edit makes the editor render its previews again; React sets the inner HTML again whenever the
 * object it is given is a new one, which parses and replaces the whole drawing and makes the
 * editor read the page's layout, though the markup is the very string it was. The drawing is left
 * in place while its markup is.
 */

import { content, expect, test } from "./room";

test("typing in a paragraph leaves the drawn diagram and the formula in place", async ({ join, seed }) => {
	await seed(
		"# Stable drawings\n\nA paragraph to type in.\n\n```mermaid\ngraph TD;\nNear-->Top;\n```\n\n$$\nE = mc^2\n$$\n",
	);
	let page = await join("ana");
	let editor = content(page);
	let diagram = editor.locator("[data-plan-language='mermaid'] .plan-diagram svg");
	let formula = editor.locator(".planMath .katex");
	await expect(diagram).toBeVisible();
	await expect(formula).toBeVisible();
	// Mark what the page drew, and watch for the markup being written into again.
	await page.evaluate(() => {
		let drawings = document.querySelectorAll(
			"[data-plan-language='mermaid'] .plan-diagram svg, .planMath .katex",
		);
		for (let drawing of drawings) drawing.setAttribute("data-drawn-before", "");
		let writes: number[] = [];
		Object.defineProperty(window, "__writes", { get: () => writes });
		new MutationObserver(records => {
			for (let record of records) {
				let target = record.target instanceof Element ? record.target : record.target.parentElement;
				if (
					target?.closest(
						"[data-plan-language='mermaid'] .plan-diagram, .planMath [data-plan-preview]",
					)
				) {
					writes.push(record.addedNodes.length + record.removedNodes.length);
				}
			}
		}).observe(document.body, { subtree: true, childList: true, characterData: true });
	});

	let paragraph = editor.getByText("A paragraph to type in.", { exact: true });
	await paragraph.click();
	await page.keyboard.press("End");
	await page.keyboard.type(" And some more words, one key at a time.", { delay: 30 });
	await expect(editor.getByText("And some more words, one key at a time.")).toBeVisible();
	await page.waitForTimeout(300);

	// The same drawings, written into by nobody.
	await expect.soft(diagram).toHaveAttribute("data-drawn-before", "");
	await expect.soft(formula).toHaveAttribute("data-drawn-before", "");
	let writes = await page.evaluate(() => (window as unknown as { __writes: number[] }).__writes);
	expect.soft(writes).toEqual([]);
});
