import { readSource, seedPendingLegacyResearchWorkspace } from "./database";
import { content, expect, test } from "./room";

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
	await expect(page.getByRole("heading", { name: "Cannot open Chopin", exact: true }))
		.toBeVisible();
	await expect(page.getByText("This page does not exist.", { exact: true })).toBeVisible();
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
			draftLeft: draftBox.left,
			draftRight: draftBox.right,
			draftTop: draftBox.top,
			editorLeft: editorBox.left,
			editorRight: editorBox.right,
		};
	});
	expect(geometry.draftLeft).toBeGreaterThanOrEqual(geometry.editorLeft);
	expect(geometry.draftRight).toBeLessThanOrEqual(geometry.editorRight);
	expect(geometry.draftLeft - geometry.editorLeft).toBeLessThan(10);
	expect(geometry.editorRight - geometry.draftRight).toBeLessThan(10);
	expect(Math.abs(geometry.draftTop - geometry.anchorBottom)).toBeLessThan(2);

	let scroller = page.locator("[data-plan-scroll]");
	let scrollTop = await scroller.evaluate(element => element.scrollTop);
	expect(scrollTop).toBeGreaterThan(120);
	await scroller.evaluate(element => element.scrollTop -= 120);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrollTop - 120);
	await expect.poll(() =>
		composer.evaluate(element => {
			let anchor = document.querySelector<HTMLElement>("[data-research-draft-anchor]")!;
			return Math.abs(
				element.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom,
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
