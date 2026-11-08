/**
 * Diagrams are drawn when they come near, not when the document opens.
 *
 * Mermaid is a large chunk and each drawing is laid out in a hidden copy of the page before the
 * document is laid out again around it. Which blocks count as near is `near-viewport.test.ts`;
 * what a reader sees of a diagram that is not drawn yet, and that it is drawn on the way to it, is
 * browser behaviour.
 */

import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

/** Whether the page has fetched the Mermaid chunk, which the first drawing asks for. */
function fetchedMermaid(page: Page) {
	return page.evaluate(() =>
		performance.getEntriesByType("resource").some(entry => /mermaid/.test(entry.name))
	);
}

const DIAGRAM = "```mermaid\ngraph TD;\nFar-->Away;\n```";
/** Several screens of prose, so a diagram after it is well beyond a screen of the first view. */
const PROSE = "A paragraph of the specification, long enough to take a line of its own.\n\n".repeat(
	150,
);

test("a diagram far below the first screen is drawn on the way to it, not when the document opens", async ({ join, seed }) => {
	await seed(`# Specification\n\n${PROSE}${DIAGRAM}\n\n${PROSE.slice(0, 600)}\n`);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let diagram = content(page).locator('[data-plan-language="mermaid"]');
	await expect(diagram).toHaveCount(1);
	// Its block has its controls, so its preview has mounted and would have started drawing.
	await expect(diagram.locator(".plan-code-chrome")).toBeAttached();
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
	expect(await fetchedMermaid(page)).toBe(false);
	await expect(diagram.locator(".plan-diagram")).toHaveCount(0);
	// The reader sees its source, as they do for a drawing that is on its way.
	await expect(diagram.locator("[data-plan-source]")).toContainText("Far-->Away");

	await diagram.scrollIntoViewIfNeeded();
	await expect(diagram.getByRole("region", { name: "Diagram preview" }).locator("svg"))
		.toBeVisible();
	await expect(diagram.locator("[data-plan-source]")).toBeHidden();
	expect(await fetchedMermaid(page)).toBe(true);
});

test("a diagram within a screen of the first view is drawn with the document, and a long way on is still not", async ({ join, seed }) => {
	await seed(
		`# Specification\n\n${DIAGRAM.replace("Far-->Away", "Near-->Top")}\n\n${PROSE}${DIAGRAM}\n`,
	);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let diagrams = content(page).locator('[data-plan-language="mermaid"]');
	await expect(diagrams).toHaveCount(2);
	await expect(diagrams.first().getByRole("region", { name: "Diagram preview" }).locator("svg"))
		.toBeVisible();
	await expect(diagrams.last().locator(".plan-code-chrome")).toBeAttached();
	await expect(diagrams.last().locator(".plan-diagram")).toHaveCount(0);
});
