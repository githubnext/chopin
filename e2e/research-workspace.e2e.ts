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
	let composer = page.getByRole("region", {
		name: "Research question",
		exact: true,
		includeHidden: true,
	});

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
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	let ending = page.getByText("Workspace passage 36.", { exact: true });
	await expect(ending).toBeVisible();
	let endingBox = (await ending.boundingBox())!;
	await ending.click({ position: { x: endingBox.width - 1, y: endingBox.height / 2 } });
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Enter");

	let composer = page.getByRole("region", {
		name: "Research question",
		exact: true,
		includeHidden: true,
	});
	let question = composer.getByRole("textbox", { name: "Research question", exact: true });
	let firstLine = "Compare the evidence across public sources.";
	let secondLine = "Call out disagreements between sources.";
	await expect(question).toBeFocused();
	await page.keyboard.type(firstLine);
	await page.keyboard.press("Meta+Enter");
	await page.keyboard.type(secondLine);
	await expect(question).toHaveValue(`${firstLine}\n${secondLine}`);

	await page.getByText("Workspace passage 36.", { exact: true }).click();
	expect(errors).toEqual([]);
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
			anchorWidth: anchorBox.width,
			anchorGap: Number.parseFloat(getComputedStyle(anchor).marginBottom),
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
	// The private draft occupies the prose column in normal document flow.
	expect(Math.abs(geometry.draftLeft - geometry.anchorLeft)).toBeLessThan(2);
	expect(Math.abs(geometry.draftWidth - geometry.anchorWidth)).toBeLessThan(2);
	expect(Math.abs(geometry.draftTop - geometry.anchorBottom - geometry.anchorGap))
		.toBeLessThan(2);

	let scroller = page.locator("[data-plan-scroll]");
	let scrollTop = await scroller.evaluate(element => element.scrollTop);
	expect(scrollTop).toBeGreaterThan(120);
	await scroller.evaluate(element => element.scrollTop -= 120);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrollTop - 120);
	// Scrolling moves both blocks together without changing their prose spacing.
	await expect.poll(() =>
		composer.evaluate(element => {
			let anchorElement = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
			let anchor = anchorElement.getBoundingClientRect();
			let draft = element.getBoundingClientRect();
			let gap = Number.parseFloat(getComputedStyle(anchorElement).marginBottom);
			return Math.abs(draft.top - anchor.bottom - gap);
		})
	).toBeLessThan(2);

	await question.focus();
	await page.keyboard.press("Escape");
	await expect(composer).toHaveCount(0);

	await ending.click({ position: { x: endingBox.width - 1, y: endingBox.height / 2 } });
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.keyboard.press("Enter");
	let emptyComposer = page.getByRole("region", {
		name: "Research question",
		exact: true,
		includeHidden: true,
	});
	let emptyQuestion = emptyComposer.getByRole("textbox", {
		name: "Research question",
		exact: true,
	});
	await expect(emptyQuestion).toHaveValue("");
	await expect(emptyQuestion).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(emptyComposer).toHaveCount(0);
	expect(errors).toEqual([]);
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
		let anchorBox = anchor.getBoundingClientRect();
		let bounds = scroller.getBoundingClientRect();
		return {
			attached: anchor.nextElementSibling?.contains(draft) === true,
			gap: box.top - anchorBox.bottom,
			margin: Number.parseFloat(getComputedStyle(anchor).marginBottom),
			inside: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
			width: box.width,
			anchorWidth: anchorBox.width,
			top: box.top,
			paneTop: bounds.top,
		};
	});
}

test("the inline research draft scrolls with its anchor and stays inside the prose column", async ({ join, seed }) => {
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
	await question.fill("Keep this private draft attached while scrolling and resizing.");
	await expect.poll(async () => {
		let geometry = await draftGeometry(page);
		return geometry.inside && geometry.attached
			&& Math.abs(geometry.gap - geometry.margin) < 2;
	}).toBe(true);

	// A normal flow block scrolls out of view and is clipped by its document pane.
	let scroller = page.locator("[data-plan-scroll]");
	let pane = (await scroller.boundingBox())!;
	// Use the pane gutter so the draft's textarea does not consume the wheel gesture.
	await page.mouse.move(pane.x + 8, pane.y + pane.height / 2);
	await page.mouse.wheel(
		0,
		await scroller.evaluate(element => {
			let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
			return anchor.getBoundingClientRect().bottom - element.getBoundingClientRect().top + 40;
		}),
	);
	await expect.poll(() => draftGeometry(page).then(geometry => geometry.top < geometry.paneTop))
		.toBe(true);
	expect(
		await question.evaluate(element => {
			let draft = element.closest(".plan-research-draft")!;
			let pane = draft.closest("[data-plan-scroll]")!;
			let point = document.elementFromPoint(
				draft.getBoundingClientRect().left + 8,
				pane.getBoundingClientRect().top - 2,
			);
			return point ? draft.contains(point) : null;
		}),
	).toBe(false);

	// Moving the anchor toward the bottom does not turn the draft into a floating overlay.
	await scroller.evaluate(element => {
		let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
		element.scrollTop -= element.getBoundingClientRect().bottom - 48
			- anchor.getBoundingClientRect().bottom;
	});
	await expect.poll(async () => {
		let geometry = await draftGeometry(page);
		return geometry.attached && Math.abs(geometry.gap - geometry.margin) < 2;
	}).toBe(true);

	await page.setViewportSize({ width: 390, height: 600 });
	await expect.poll(async () => {
		let geometry = await draftGeometry(page);
		return geometry.attached && Math.abs(geometry.width - geometry.anchorWidth) < 2
			&& Math.abs(geometry.gap - geometry.margin) < 2;
	}).toBe(true);
	await expect(question).toBeFocused();
	await expect(question).toHaveValue(
		"Keep this private draft attached while scrolling and resizing.",
	);
	await expect(editor).toBeVisible();
});
