import { authenticate, expect, test } from "./room";

test("an authenticated repository creates a channel workspace", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	await expect(page.getByRole("heading", { name: "Where are you planning?" })).toBeVisible();
	await page.getByRole("link", { name: /octo-org\/score/ }).click();
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await page.getByLabel("Channel title").fill("Release readiness");
	await page.getByRole("button", { name: "New channel" }).click();

	await expect(page).toHaveURL(/\/channels\/[0-9a-f-]{36}$/);
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
	await expect(page.locator(".plan-decisions")).toBeVisible();
	await expect(page.getByText("octo-org/score / Release readiness")).toBeVisible();
});
