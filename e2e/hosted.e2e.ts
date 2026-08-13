import { expect, test } from "@playwright/test";

const CHANNEL = "019c1234-1234-4123-8123-123456789abc";

const repository = {
	id: "R_score",
	owner: "octo-org",
	name: "score",
	fullName: "octo-org/score",
	private: true,
	url: "https://github.com/octo-org/score",
	defaultBranch: "main",
	permissions: { pull: true, push: true, admin: false },
};

const channel = {
	id: CHANNEL,
	repositoryId: repository.id,
	repositoryOwner: repository.owner,
	repositoryName: repository.name,
	title: "Release readiness",
	createdBy: "U_octocat",
	revision: 0,
	createdAt: "2026-08-13T12:00:00.000Z",
	updatedAt: "2026-08-13T12:00:00.000Z",
};

test("an authenticated repository leads into its channel workspace", async ({ page }) => {
	await page.route("**/api/**", async route => {
		let path = new URL(route.request().url()).pathname;
		if (path === "/api/session") {
			return route.fulfill({
				json: {
					mode: "github",
					agent: true,
					user: { id: "U_octocat", login: "octocat", avatarUrl: "avatar" },
					expiresAt: "2026-09-12T12:00:00.000Z",
				},
			});
		}
		if (path === "/api/repositories") {
			return route.fulfill({ json: { repositories: [repository] } });
		}
		if (path === "/api/repositories/octo-org/score/channels") {
			return route.fulfill({
				json: { repository, canEdit: true, channels: [channel] },
			});
		}
		if (path === `/api/channels/${CHANNEL}`) {
			return route.fulfill({ json: { repository, canEdit: true, channel } });
		}
		return route.fallback();
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Where are you planning?" })).toBeVisible();
	await page.getByRole("link", { name: /octo-org\/score/ }).click();
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await page.getByRole("link", { name: /Release readiness/ }).click();

	await expect(page).toHaveURL(new RegExp(`/channels/${CHANNEL}$`));
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
	await expect(page.locator(".plan-decisions")).toBeVisible();
	await expect(page.getByText("octo-org/score / Release readiness")).toBeVisible();
});
