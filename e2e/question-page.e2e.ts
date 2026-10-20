import { writtenSeed } from "./decision-deck-fixtures";
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
	async ({ join, seed }, info) => {
		let decision = writtenSeed(QUESTION);
		await seed(decision.source, decision.state);
		let ana = await join("ana");
		let ben = await join("ben");
		await decisions(ana);
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

		await card(ana).getByRole("button", { name: "Expand decision" }).click();
		await expect(questionPage(ana).getByRole("heading", { level: 1, name: QUESTION }))
			.toBeVisible();
		let status = questionPage(ana).locator("[data-question-page-status]");
		await expect(status.getByText("Waiting for", { exact: true })).toBeVisible();
		await expect(status.getByText("ben", { exact: true })).toBeVisible();
		let bar = ana.locator("[data-question-page-actions]");
		await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await expect(questionPage(ana).getByRole("heading", { name: "Takes" })).toBeVisible();
		await expect(questionPage(ana).getByRole("heading", { name: "Notes" })).toBeVisible();

		await card(ben).getByRole("button", { name: "Expand decision" }).click();
		await questionPage(ben).getByRole("textbox", { name: "Your take" }).fill(
			"Infer it from their documents.",
		);
		await questionPage(ben).getByRole("button", { name: "Objects", exact: true }).click();
		await questionPage(ben).getByRole("button", { name: "Reply", exact: true }).click();
		await expect(questionPage(ana)).toContainText("Infer it from their documents.");
		await expect(questionPage(ana).getByText("Objects", { exact: true })).toBeVisible();
		await expect(questionPage(ana)).toContainText("Open");
		await ana.screenshot({ path: info.outputPath("open-page.png") });

		await questionPage(ana).getByRole("textbox", { name: "Answer" }).fill(
			"Inferred from their documents.",
		);
		await bar.getByRole("button", { name: "Save", exact: true }).click();
		await expect(questionPage(ana)).toContainText("Settled");
		await expect(questionPage(ana)).toContainText("by ana");
		await expect(questionPage(ana).getByRole("textbox", { name: "Answer" })).toBeDisabled();
		await expect(questionPage(ana).getByRole("textbox", { name: "Answer" })).toHaveValue(
			"Inferred from their documents.",
		);
		await expect(questionPage(ben)).toContainText("by ana");
		await ana.screenshot({ path: info.outputPath("settled-page.png") });

		let why = (page: Page) => questionPage(page).getByRole("textbox", { name: "Why" });
		await expect(why(ana)).toHaveAttribute("data-placeholder", "Add a reason");
		await expect(why(ana)).toHaveText("");
		await why(ana).click();
		await ana.keyboard.type("Inferring adds no second store.");
		await ana.keyboard.press("Enter");
		await expect(why(ben)).toHaveText("Inferring adds no second store.");
		await why(ben).click();
		await ben.keyboard.type(" Draft that is abandoned");
		await ben.keyboard.press("Escape");
		await expect(why(ben)).toHaveText("Inferring adds no second store.");
		await expect(why(ana)).toHaveText("Inferring adds no second store.");
		await why(ana).click();
		await ana.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+a`);
		await ana.keyboard.press("Backspace");
		await ana.keyboard.press("Enter");
		await expect(why(ben)).toHaveText("");

		await bar.getByRole("button", { name: "Reopen", exact: true }).click();
		await expect(questionPage(ana).getByRole("textbox", { name: "Answer" })).toBeVisible();
		await expect(questionPage(ana)).toContainText("Inferred from their documents.");
	},
);

const LAYOUTS = [
	["a phone", { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }],
	["a compact layout", { viewport: { width: 640, height: 900 } }],
] as const;

for (let [name, options] of LAYOUTS) {
	test(`on ${name} a decision's page keeps Copy link and Discard decision`, async ({ join, seed }) => {
		let fresh = crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase();
		let decision = writtenSeed(QUESTION, undefined, `01K0N4TR8K7JGM4R1J7PW4${fresh}`);
		await seed(decision.source, decision.state);
		let page = await join("ana", options);
		await decisions(page);
		await card(page).getByRole("button", { name: "Expand decision" }).click();
		await expect(questionPage(page).getByRole("heading", { level: 1, name: QUESTION }))
			.toBeVisible();
		let menu = page.getByRole("button", { name: `Actions for ${QUESTION}`, exact: true });
		await expect(menu).toHaveCount(1);
		await menu.click();
		await expect(page.getByText("Copy link", { exact: true })).toBeVisible();
		await expect(page.getByText("Rename", { exact: true })).toHaveCount(0);
		await page.getByText("Discard decision…", { exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Discard this decision?" });
		await dialog.getByRole("button", { name: "Keep it" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(questionPage(page)).toBeVisible();
		await menu.click();
		await page.getByText("Discard decision…", { exact: true }).click();
		await dialog.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(questionPage(page)).toHaveCount(0);
	});
}
