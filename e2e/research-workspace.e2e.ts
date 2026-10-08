import { readSource, seedPendingLegacyResearchWorkspace } from "./database";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

const WORKSPACE_SOURCE = `# Inline research

${Array.from({ length: 36 }, (_, index) => `Workspace passage ${index + 1}.`).join("\n\n")}
`;

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

test("a pending legacy workspace has no standalone product surface", async ({ baseURL, join, room }) => {
	let legacy = await seedPendingLegacyResearchWorkspace(
		port(baseURL!),
		room,
		`Pending legacy research ${room.slice(0, 8)}`,
	);
	let page = await join("ana");
	let sidebar = page.getByRole("complementary", { name: "Projects" });

	await expect(sidebar.getByRole("button", { name: /New research in/ })).toHaveCount(0);
	await expect(sidebar.getByRole("link", { name: legacy.title, exact: true })).toHaveCount(0);
	await expect(sidebar.locator(`a[href="${legacy.path}"]`)).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: /New research in/ })).toHaveCount(0);
	await expect(page.getByText("Private draft", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Review before searching", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Continue the research", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Ask from research", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search more", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Cancel active research turn", exact: true }))
		.toHaveCount(0);

	await page.goto(legacy.path);
	await expect(page.getByRole("heading", { name: "Page not found", exact: true }))
		.toBeVisible();
	await expect(page.getByText("This page doesn't exist.", { exact: true })).toBeVisible();
});

test("click and Tab both insert the inline Research draft", async ({ join, seed }) => {
	await seed("# Research selection\n");
	let page = await join("ana");
	let editor = content(page);
	let composer = page.getByRole("region", { name: "Research question", exact: true });

	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Research", exact: true })
		.click();
	await expect(composer.getByRole("textbox", { name: "Research question", exact: true }))
		.toBeFocused();
	await page.keyboard.press("Escape");
	await expect(composer).toHaveCount(0);

	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await expect(
		page.getByRole("listbox", { name: "Insert block" })
			.getByRole("option", { name: "Research", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(composer.getByRole("textbox", { name: "Research question", exact: true }))
		.toBeFocused();
});

test("a private research draft keeps its authored geometry until explicit dismissal", async ({ baseURL, join, room, seed }) => {
	await seed(WORKSPACE_SOURCE);
	let page = await join("ana");
	let editor = content(page);
	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Enter");

	let composer = page.getByRole("region", { name: "Research question", exact: true });
	let question = composer.getByRole("textbox", { name: "Research question", exact: true });
	let firstLine = "Compare the evidence across public sources.";
	let secondLine = "Call out disagreements between sources.";
	await expect(question).toBeFocused();
	await page.keyboard.type(firstLine);
	await page.keyboard.press("Meta+Enter");
	await page.keyboard.type(secondLine);
	await expect(question).toHaveValue(`${firstLine}\n${secondLine}`);

	await page.getByText("Workspace passage 36.", { exact: true }).click();
	await expect(composer).toBeVisible();
	await expect(question).toHaveValue(`${firstLine}\n${secondLine}`);
	await expect(page.locator("[data-research-draft-anchor]")).toHaveCount(1);

	let geometry = await composer.evaluate(element => {
		let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
		let editor = document.querySelector<HTMLElement>(
			'[role="textbox"][aria-label="editable markdown"]',
		)!;
		let draftBox = element.getBoundingClientRect();
		let anchorBox = anchor.getBoundingClientRect();
		let editorBox = editor.getBoundingClientRect();
		return {
			anchorBottom: anchorBox.bottom,
			anchorLeft: anchorBox.left,
			draftLeft: draftBox.left,
			draftRight: draftBox.right,
			draftTop: draftBox.top,
			draftWidth: draftBox.width,
			editorLeft: editorBox.left,
			editorRight: editorBox.right,
		};
	});
	expect(geometry.draftLeft).toBeGreaterThanOrEqual(geometry.editorLeft);
	expect(geometry.draftRight).toBeLessThanOrEqual(geometry.editorRight);
	// The draft starts on the prose column and stops at its 450px cap.
	expect(Math.abs(geometry.draftLeft - geometry.anchorLeft)).toBeLessThan(2);
	expect(geometry.draftWidth).toBeLessThanOrEqual(450);
	expect(Math.abs(geometry.draftTop - geometry.anchorBottom)).toBeLessThan(2);

	let scroller = page.locator("[data-plan-scroll]");
	let scrollTop = await scroller.evaluate(element => element.scrollTop);
	expect(scrollTop).toBeGreaterThan(120);
	await scroller.evaluate(element => element.scrollTop -= 120);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrollTop - 120);
	// It stays attached to its anchor: directly below, or flipped above near the bottom edge.
	await expect.poll(() =>
		composer.evaluate(element => {
			let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!
				.getBoundingClientRect();
			let draft = element.getBoundingClientRect();
			return Math.min(
				Math.abs(draft.top - anchor.bottom),
				Math.abs(draft.bottom - anchor.top),
			);
		})
	).toBeLessThan(2);

	await question.focus();
	await page.keyboard.press("Escape");
	await expect(composer).toHaveCount(0);

	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Enter");
	let emptyComposer = page.getByRole("region", { name: "Research question", exact: true });
	let emptyQuestion = emptyComposer.getByRole("textbox", {
		name: "Research question",
		exact: true,
	});
	await expect(emptyQuestion).toHaveValue("");
	await expect(emptyQuestion).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(emptyComposer).toHaveCount(0);
	await expect.poll(() => readSource(port(baseURL!), room)).not.toContain("<Research");

	await expect(page.getByRole("button", { name: "Start research", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Ask from research", exact: true }))
		.toHaveCount(0);
});

async function draftGeometry(page: Page) {
	return await page.evaluate(() => {
		let draft = document.querySelector<HTMLElement>(".plan-research-draft")!;
		let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
		let scroller = document.querySelector<HTMLElement>("[data-plan-scroll]")!;
		let box = draft.getBoundingClientRect();
		let bounds = scroller.getBoundingClientRect();
		return {
			anchor: anchor.getBoundingClientRect().toJSON() as DOMRect,
			bottom: box.bottom,
			inside: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
			side: draft.dataset.side,
			top: box.top,
		};
	});
}

test("the research draft stays fully visible as its anchor nears an edge", async ({ join, seed }) => {
	await seed(WORKSPACE_SOURCE);
	let page = await join("ana");
	let editor = content(page);
	// Place the caret by clicking the end of the line; End scrolls the document on macOS.
	let passage = page.getByText("Workspace passage 12.", { exact: true });
	let box = (await passage.boundingBox())!;
	await passage.click({ position: { x: box.width - 1, y: box.height / 2 } });
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Enter");
	let question = page.getByRole("textbox", { name: "Research question", exact: true });
	await expect(question).toBeFocused();
	// The reveal may still be scrolling; wait for it to settle below the anchor.
	await expect.poll(async () => {
		let geometry = await draftGeometry(page);
		return geometry.inside && geometry.side === "below";
	}).toBe(true);

	// Scrolled partly past the top, the draft is clipped to the pane rather than drawn over its tabs.
	let scroller = page.locator("[data-plan-scroll]");
	// Wheel input, like a reader's, also ends the opening reveal.
	let pane = (await scroller.boundingBox())!;
	await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
	await page.mouse.wheel(
		0,
		await scroller.evaluate(element => {
			let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
			return anchor.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 40;
		}),
	);
	await expect.poll(() =>
		page.evaluate(() => {
			let draft = document.querySelector<HTMLElement>(".plan-research-draft")!;
			let scroller = document.querySelector<HTMLElement>("[data-plan-scroll]")!;
			let hidden = Number(/inset\((-?[\d.]+)px/.exec(draft.style.clipPath)?.[1] ?? 0);
			return draft.getBoundingClientRect().top + Math.max(0, hidden)
					>= scroller.getBoundingClientRect().top - 1 && hidden > 0;
		})
	).toBe(true);

	// Scroll the anchor to just above the bottom edge: the draft flips above it.
	await scroller.evaluate(element => {
		let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
		element.scrollTop -= element.getBoundingClientRect().bottom - 48
			- anchor.getBoundingClientRect().bottom;
	});
	await expect.poll(async () => (await draftGeometry(page)).side).toBe("above");
	let flipped = await draftGeometry(page);
	expect(flipped.inside).toBe(true);
	expect(Math.abs(flipped.bottom - flipped.anchor.top)).toBeLessThan(2);

	// A shorter viewport, as when an on-screen keyboard opens, scrolls the draft back into view.
	let size = page.viewportSize()!;
	await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.6) });
	await expect.poll(async () => {
		let geometry = await draftGeometry(page);
		return geometry.inside && geometry.side === "below";
	}).toBe(true);
	await expect(question).toBeFocused();
	await expect(editor).toBeVisible();
});
