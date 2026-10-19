import { expect, test } from "./room";
import type { Page } from "@playwright/test";

const QUESTION = "Where should onboarding progress live?";

async function decisions(page: Page) {
	await page.getByRole("navigation", { name: "Workspace view" })
		.or(page.getByRole("group", { name: "Document view", exact: true }))
		.getByRole("button", { name: /^Decisions/ }).click();
	return page.locator('[data-document-view="decisions"]:visible');
}

function card(page: Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: QUESTION, exact: true }) });
}

function questionPage(page: Page) {
	return page.locator("[data-question-page]");
}

test(
	"a decision is explored, opened as its own page, answered by the asked member and settled",
	async ({ join }, info) => {
		let ana = await join("ana");
		let ben = await join("ben");
		let view = await decisions(ana);
		await view.getByRole("button", { name: "New decision", exact: true }).click();
		await view.getByRole("textbox", { name: "Decision question" }).fill(QUESTION);
		await view.getByRole("button", { name: "Create decision", exact: true }).click();
		await expect(card(ana).getByRole("textbox", { name: "Answer" })).toBeVisible();
		await decisions(ben);
		await expect(card(ben)).toBeVisible();

		await card(ana).getByRole("button", { name: "Research", exact: true }).click();
		let menu = ana.getByRole("dialog", { name: "Research", exact: true });
		await expect(menu.getByRole("button", { name: "Research the web" })).toBeFocused();
		await expect(menu.getByRole("button", { name: "Research the web" })).toBeVisible();
		// Nobody here has a paired machine, so the investigation says why it cannot run.
		await expect(menu.getByRole("button", { name: /^Investigate the codebase/ }))
			.toHaveAttribute("aria-disabled", "true");
		await ana.screenshot({ path: info.outputPath("explore-menu.png") });
		await menu.getByRole("button", { name: "Ask someone" }).click();
		await menu.getByRole("button", { name: "@ben" }).click();
		await expect(menu).toHaveCount(0);
		await expect(card(ana).getByText("Waiting for ben")).toBeVisible();

		await card(ana).getByRole("button", { name: "Open as a page" }).click();
		await expect(questionPage(ana).getByRole("heading", { level: 1, name: QUESTION }))
			.toBeVisible();
		await expect(questionPage(ana)).toContainText("Waiting for @ben");
		await expect(questionPage(ana).getByRole("heading", { name: "Takes" })).toBeVisible();
		await expect(questionPage(ana).getByRole("heading", { name: "Notes" })).toBeVisible();

		await card(ben).getByRole("button", { name: "Open as a page" }).click();
		await questionPage(ben).getByRole("textbox", { name: "Your take" }).fill(
			"Infer it from their documents.",
		);
		await questionPage(ben).getByRole("button", { name: "Reply", exact: true }).click();
		await expect(questionPage(ana)).toContainText("Infer it from their documents.");
		await expect(questionPage(ana)).toContainText("Open");
		await ana.screenshot({ path: info.outputPath("open-page.png") });

		let control = questionPage(ana).locator(".question-page-control");
		await control.getByRole("textbox", { name: "Answer" }).fill("Inferred from their documents.");
		await control.getByRole("button", { name: "Save", exact: true }).click();
		await expect(questionPage(ana)).toContainText("Settled");
		await expect(questionPage(ana)).toContainText("Settled by @ana");
		await expect(questionPage(ben)).toContainText("Settled by @ana");
		await ana.screenshot({ path: info.outputPath("settled-page.png") });

		await questionPage(ana).getByRole("button", { name: "Reopen", exact: true }).click();
		await expect(control.getByRole("textbox", { name: "Answer" })).toBeVisible();
		await expect(control).toContainText("Inferred from their documents.");
	},
);
