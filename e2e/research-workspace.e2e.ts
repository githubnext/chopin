import { seedPendingLegacyResearchWorkspace } from "./database";
import { content, expect, test } from "./room";

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

test("research creation remains available through the editor slash menu", async ({ join }) => {
	let page = await join("ana");

	await content(page).click();
	await page.keyboard.type("/research");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Research" })
		.click();

	await expect(page.getByRole("textbox", { name: "Research question", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("button", { name: "Start research", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Ask from research", exact: true }))
		.toHaveCount(0);
});
