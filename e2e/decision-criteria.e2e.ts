/**
 * A decision judged against criteria: marks are shared, a criterion can be appended, and settling
 * leaves a table in place of the options.
 */

import { storedQuestion } from "../apps/server/src/testing/plan";
import { expect, test } from "./room";

import type { Page } from "@playwright/test";

const PROMPT = "Where should onboarding progress live?";
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8C0";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3C0";
const ACCOUNT = "01K0N4W3B7P27CBAEC7A8C8WC1";
const BROWSER = "01K0N4W3B7P27CBAEC7A8C8WC2";
const NEW_DEVICE = "01K0N4W3B7P27CBAEC7A8C8WD1";
const EASY_RESET = "01K0N4W3B7P27CBAEC7A8C8WD2";

function seedCriteria() {
	let definition = {
		questions: [{
			id: QUESTION,
			header: "Progress",
			question: PROMPT,
			multiple: false,
			options: [
				{ id: ACCOUNT, label: "Stored with the account", description: "" },
				{ id: BROWSER, label: "Kept in the browser", description: "" },
			],
			criteria: [
				{ id: NEW_DEVICE, label: "New device" },
				{ id: EASY_RESET, label: "Easy reset" },
			],
		}],
	};
	let source = `<Questionnaire id="${WIDGET}">
<Question id="${QUESTION}" header="Progress" prompt="${PROMPT}" multiple="false">
<Option id="${ACCOUNT}" label="Stored with the account" />
<Option id="${BROWSER}" label="Kept in the browser" />
<Criterion id="${NEW_DEVICE}" label="New device" />
<Criterion id="${EASY_RESET}" label="Easy reset" />
</Question>
</Questionnaire>
`;
	return {
		source,
		state: {
			revision: 1,
			questions: [{
				id: WIDGET,
				definition,
				status: "open" as const,
				origin: "human" as const,
				owner: "ana",
				history: [],
				optionOrigins: {},
				editors: ["ana"],
			}],
			openQuestions: [{
				definition,
				id: WIDGET,
				model: storedQuestion(definition),
				revision: 0,
				widget: WIDGET,
			}],
		},
	};
}

async function decisions(page: Page) {
	await page.getByRole("navigation", { name: "Workspace view" })
		.or(page.getByRole("group", { name: "Document view", exact: true }))
		.getByRole("button", { name: /^Decisions/ }).click();
}

function card(page: Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: PROMPT, exact: true }) });
}

const cell = (page: Page, option: string, criterion: string) =>
	card(page).getByRole("button", { name: new RegExp(`^${option}, ${criterion}: `) });

test("marks are shared, a criterion can be appended and settling leaves a table", async (
	{ join, seed },
	info,
) => {
	let { source, state } = seedCriteria();
	await seed(source, state);
	let ana = await join("ana");
	let ben = await join("ben");
	await decisions(ana);
	await decisions(ben);

	await expect(cell(ana, "Stored with the account", "New device")).toHaveAccessibleName(
		"Stored with the account, New device: not set",
	);
	await cell(ana, "Stored with the account", "New device").click();
	await ana.getByRole("radio", { name: "Partly", exact: true }).click();
	await expect(cell(ana, "Stored with the account", "New device")).toHaveAccessibleName(
		"Stored with the account, New device: partly",
	);
	await expect(cell(ben, "Stored with the account", "New device")).toHaveAccessibleName(
		"Stored with the account, New device: partly",
	);
	await ana.screenshot({ path: info.outputPath("marked.png") });

	// The keyboard opens a cell, arrows move between the glyphs and Enter chooses.
	await cell(ben, "Kept in the browser", "Easy reset").focus();
	await ben.keyboard.press("Enter");
	await ben.keyboard.press("ArrowRight");
	await ben.keyboard.press("ArrowRight");
	await ben.keyboard.press("Enter");
	await expect(cell(ana, "Kept in the browser", "Easy reset")).toHaveAccessibleName(
		"Kept in the browser, Easy reset: no",
	);
	await expect(cell(ben, "Kept in the browser", "Easy reset")).toBeFocused();
	await ben.keyboard.press("Backspace");
	await expect(cell(ana, "Kept in the browser", "Easy reset")).toHaveAccessibleName(
		"Kept in the browser, Easy reset: not set",
	);

	await card(ana).getByRole("button", { name: "Add a criterion" }).click();
	await ana.keyboard.type("Works offline");
	await ana.keyboard.press("Enter");
	await expect(card(ana).getByText("Works offline", { exact: true }).first()).toBeVisible();
	await expect(card(ben).getByText("Works offline", { exact: true }).first()).toBeVisible();

	await card(ana).getByText("Kept in the browser", { exact: true }).click();
	await card(ana).getByRole("button", { name: "Expand decision" }).click();
	let page = ana.locator("[data-question-page]");
	await expect(page.getByRole("heading", { level: 1, name: PROMPT })).toBeVisible();
	await ana.locator("[data-question-page-actions]").getByRole("button", {
		name: "Save",
		exact: true,
	})
		.click();

	let table = page.getByRole("table", { name: "Options by criterion" });
	await expect(table).toBeVisible();
	await expect(table.getByRole("columnheader", { name: "New device" })).toBeVisible();
	await expect(table.getByRole("columnheader", { name: "Works offline" })).toBeVisible();
	await expect(table.getByRole("img", { name: "Stored with the account, New device: partly" }))
		.toBeVisible();
	await expect(table.locator("tr[data-chosen]")).toContainText("Kept in the browser");
	await expect(page.getByText("What we considered")).toHaveCount(0);
	await ana.screenshot({ path: info.outputPath("settled.png") });
});
