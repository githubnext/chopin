import { content, expect, roomPath, test } from "./room";

test("research creation exists only in the editor slash menu", async ({ join }) => {
	let page = await join("ana");
	let sidebar = page.getByRole("complementary", { name: "Projects" });

	await expect(sidebar.getByRole("button", { name: /New research in/ })).toHaveCount(0);
	await expect(sidebar.locator('a[href*="/research/"]')).toHaveCount(0);

	await content(page).click();
	await page.keyboard.type("/research");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Research" })
		.click();

	await expect(page.getByRole("textbox", { name: "Research question", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("button", { name: "Start research", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("button", { name: "Create private draft", exact: true }))
		.toHaveCount(0);
});

test("a former standalone research URL is an ordinary missing page", async ({ join, room }) => {
	let page = await join("ana");

	await page.goto(`${roomPath(room)}/research/legacy-workspace`);

	await expect(page.getByRole("heading", { name: "Cannot open Chopin", exact: true }))
		.toBeVisible();
	await expect(page.getByText("This page does not exist.", { exact: true })).toBeVisible();
});
