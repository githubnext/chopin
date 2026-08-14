import { authenticate, expect, test } from "./room";

const score = {
	id: "R_score",
	owner: "octo-org",
	name: "score",
	fullName: "octo-org/score",
	private: true,
	url: "https://github.com/octo-org/score",
	defaultBranch: "main",
	permissions: { pull: true, push: true, admin: false },
};

const notes = {
	id: "R_notes",
	owner: "octocat",
	name: "notes",
	fullName: "octocat/notes",
	private: false,
	url: "https://github.com/octocat/notes",
	defaultBranch: "main",
	permissions: { pull: true, push: false, admin: false },
};

test("an authenticated repository creates a channel workspace", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let search = page.getByRole("combobox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	await page.getByRole("option", { name: /octo-org\/score/ }).click();
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await page.getByLabel("Channel title").fill("Release readiness");
	await page.getByRole("button", { name: "New channel" }).click();

	await expect(page).toHaveURL(/\/channels\/[0-9a-f-]{36}$/);
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
	await expect(page.locator(".plan-decisions")).toBeAttached();
	await expect(page.getByRole("button", { name: /octo-org\/score/ })).toBeVisible();
	await expect(page.getByText("Release readiness", { exact: true })).toBeVisible();

	await page.setViewportSize({ width: 320, height: 480 });
	let workspacePicker = page.getByRole("button", { name: /octo-org\/score/ });
	let pickerBounds = await workspacePicker.boundingBox();
	expect(pickerBounds).toBeTruthy();
	expect(pickerBounds!.width).toBeGreaterThan(80);
	await expect(page.getByText("Release readiness", { exact: true })).toBeVisible();
	await workspacePicker.click();
	await expect(search).toBeFocused();
	await search.fill("notes");
	await search.press("Enter");
	await expect(page).toHaveURL("/repositories/octocat/notes");
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await expect(page.getByRole("button", { name: /octocat\/notes/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "New channel" })).toHaveCount(0);
});

test("the repository picker supports dismissal and keyboard selection", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let trigger = page.getByRole("button", { name: "Choose repository" });
	let search = page.getByRole("combobox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	await search.press("Escape");
	await expect(page.getByRole("listbox", { name: "Repositories" })).toBeHidden();
	await expect(trigger).toBeFocused();

	await trigger.click();
	await expect(search).toBeFocused();
	for (let index = 0; index < 12; index++) await search.press("ArrowDown");
	await expect.poll(() => page.locator("[data-repository-scroll]").evaluate(node => node.scrollTop))
		.toBeGreaterThan(0);
	let activeId = await search.getAttribute("aria-activedescendant");
	expect(activeId).toBeTruthy();
	await expect(page.locator(`[id="${activeId}"]`)).toBeInViewport();
	await search.fill("notes");
	await search.press("Enter");
	await expect(page).toHaveURL("/repositories/octocat/notes");
});

test("the repository picker stays inside a narrow viewport", async ({ baseURL, page }) => {
	await page.setViewportSize({ width: 320, height: 200 });
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let trigger = page.getByRole("button", { name: "Choose repository" });
	await expect(page.getByRole("combobox", { name: "Search repositories" })).toBeVisible();
	let popupId = await trigger.getAttribute("aria-controls");
	let bounds = await page.locator(`[id="${popupId}"]`).boundingBox();
	expect(bounds).toBeTruthy();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(200);
});

test("the repository picker retries and appends unique pages", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	let fail = true;
	await page.route("**/api/repositories?*", async route => {
		let requested = new URL(route.request().url()).searchParams.get("page");
		if (requested === "1" && fail) {
			fail = false;
			await route.fulfill({ status: 503, json: { error: "temporary failure" } });
		} else if (requested === "1") {
			await route.fulfill({ json: { repositories: [score], nextPage: 2 } });
		} else {
			await route.fulfill({ json: { repositories: [score, notes] } });
		}
	});
	await page.goto("/");

	await expect(page.getByRole("alert")).toHaveText("Could not load repositories.");
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toBeVisible();
	await page.getByRole("button", { name: "More repositories" }).click();
	await expect(page.getByRole("option", { name: /octocat\/notes/ })).toBeVisible();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toHaveCount(1);
});

test("expired GitHub authorization returns to sign in", async ({ baseURL, page }) => {
	await authenticate(page, "expired", baseURL!);
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
});
