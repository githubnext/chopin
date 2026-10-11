import { expect, test } from "./room";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PROMPT = "Where should room state live?";

function decisionsCard(page: Page, prompt = PROMPT) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: prompt }) });
}

async function showDecisions(page: Page) {
	let decisions = page.getByRole("button", { name: /^Decisions/ });
	if (await decisions.getAttribute("aria-pressed") !== "true") await decisions.click();
}

test("phone: the save bar appears only with unsaved answers, and Save confirms before resolving", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let page = await join("ana", PHONE);
	await showDecisions(page);
	let card = decisionsCard(page);
	await expect(card).toBeVisible();
	let bar = page.locator(".decision-save-bar");
	await expect(bar).not.toHaveAttribute("data-open");
	await expect(card.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

	await card.getByText("In SQLite", { exact: true }).click();
	let region = page.getByRole("region", { name: "Unsaved answers" });
	await expect(region.getByRole("status")).toHaveText("1 unsaved answer");
	let save = region.getByRole("button", { name: "Save", exact: true });
	let box = (await save.boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(44);

	await region.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(bar).not.toHaveAttribute("data-open");
	await expect(card.getByRole("radio", { name: /In SQLite/ })).not.toBeChecked();

	await card.getByText("In SQLite", { exact: true }).click();
	await save.click();
	let confirmed = page.locator("[data-decision-confirmed]");
	await expect(confirmed.getByRole("status")).toContainText("Decided · You");
	await expect(confirmed).toContainText("In SQLite");
	await expect(bar).not.toHaveAttribute("data-open");
	await expect(confirmed).toHaveCount(0, { timeout: 5_000 });
	await expect(page.getByRole("button", { name: "1 resolved" })).toBeVisible();
	await expect(decisionsCard(page)).toHaveCount(0);
});

test("phone: an unsaved answer survives leaving Decisions and can still be saved", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let page = await join("ana", PHONE);
	await showDecisions(page);
	await decisionsCard(page).getByText("In SQLite", { exact: true }).click();
	let region = page.getByRole("region", { name: "Unsaved answers" });
	await expect(region.getByRole("status")).toHaveText("1 unsaved answer");

	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await nav.getByRole("button", { name: "Document", exact: true }).click();
	await nav.getByRole("button", { name: /^Decisions/ }).click();
	await expect(region.getByRole("status")).toHaveText("1 unsaved answer");
	await page.reload();
	await showDecisions(page);
	await expect(decisionsCard(page).getByRole("radio", { name: /In SQLite/ })).toBeChecked();
	await expect(region.getByRole("status")).toHaveText("1 unsaved answer");

	await region.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.locator("[data-decision-confirmed]").getByRole("status"))
		.toContainText("Decided · You");
	await expect(page.getByRole("button", { name: "1 resolved" })).toBeVisible();
});

test("phone: a selection the bar is not counting keeps the card's own Save", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let octocat = await join("octocat", PHONE);
	let hubot = await join("hubot", PHONE);
	for (let page of [octocat, hubot]) await showDecisions(page);
	await decisionsCard(octocat).getByText("In SQLite", { exact: true }).click();
	let card = decisionsCard(hubot);
	await expect(card.getByRole("radio", { name: /In SQLite/ })).toBeChecked();
	await expect(hubot.locator(".decision-save-bar")).not.toHaveAttribute("data-open");
	await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});

test("phone: the bar counts, clears and saves only this person's answers", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let octocat = await join("octocat", PHONE);
	let hubot = await join("hubot", PHONE);
	for (let page of [octocat, hubot]) await showDecisions(page);
	let storage = (page: Page) => decisionsCard(page);
	let scope = (page: Page) => decisionsCard(page, "Which of these belong in the first cut?");
	let bar = (page: Page) => page.locator(".decision-save-bar");

	await storage(octocat).getByText("In SQLite", { exact: true }).click();
	await expect(bar(octocat)).toHaveAttribute("data-open", "");
	await expect(storage(hubot).getByRole("radio", { name: /In SQLite/ })).toBeChecked();
	await expect(bar(hubot)).not.toHaveAttribute("data-open");

	await scope(hubot).getByText("Anchors", { exact: true }).click();
	let region = hubot.getByRole("region", { name: "Unsaved answers" });
	await expect(region.getByRole("status")).toHaveText("1 unsaved answer");
	await region.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(bar(hubot)).not.toHaveAttribute("data-open");
	await expect(scope(hubot).getByRole("checkbox", { name: /Anchors/ })).not.toBeChecked();
	await expect(storage(octocat).getByRole("radio", { name: /In SQLite/ })).toBeChecked();
	await expect(bar(octocat)).toHaveAttribute("data-open", "");

	await scope(hubot).getByText("Anchors", { exact: true }).click();
	await region.getByRole("button", { name: "Save", exact: true }).click();
	await expect(scope(hubot)).toHaveCount(0);
	await expect(scope(octocat)).toHaveCount(0);
	// octocat's open answer was neither saved nor cleared by hubot.
	await expect(storage(octocat).getByRole("radio", { name: /In SQLite/ })).toBeChecked();
	await expect(storage(hubot)).toBeVisible();
	await expect(octocat.getByRole("region", { name: "Unsaved answers" }).getByRole("status"))
		.toHaveText("1 unsaved answer");
	// Someone else's decision folds away without announcing itself.
	await expect(octocat.locator("[data-decision-confirmed] [role=status]")).toHaveCount(0);
});

for (let leave of [false, true]) {
	test(`phone: a collaborator's later change leaves the bar${leave ? " while away" : ""}`, async ({ join, seed }) => {
		await seed("Decisions on a phone.\n");
		let octocat = await join("octocat", PHONE);
		let hubot = await join("hubot", PHONE);
		for (let page of [octocat, hubot]) await showDecisions(page);
		let bar = octocat.locator(".decision-save-bar");

		await decisionsCard(octocat).getByText("In SQLite", { exact: true }).click();
		await expect(bar).toHaveAttribute("data-open", "");
		let nav = octocat.getByRole("navigation", { name: "Workspace view" });
		if (leave) await nav.getByRole("button", { name: "Document", exact: true }).click();

		await decisionsCard(hubot).getByText("On disk as MDX", { exact: true }).click();
		if (leave) await nav.getByRole("button", { name: /^Decisions/ }).click();
		let card = decisionsCard(octocat);
		await expect(card.getByRole("radio", { name: /On disk as MDX/ })).toBeChecked();
		// hubot's choice is never saved under octocat's name from the bar…
		await expect(bar).not.toHaveAttribute("data-open");
		// …but octocat can still save it deliberately on the card.
		await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
	});
}

test("phone: a failed save is announced and its card stays in view after another card folds away", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let page = await join("ana", PHONE);
	let failing = "";
	await page.context().routeWebSocket("**/ws?**", socket => {
		let server = socket.connectToServer();
		socket.onMessage(message => {
			let frame = typeof message === "string" ? JSON.parse(message) : undefined;
			if (frame?.kind === "question:submit" && frame.id === failing) {
				socket.send(JSON.stringify({
					kind: "question:submit",
					rid: frame.rid,
					ok: false,
					message: "The server could not save this decision.",
				}));
				return;
			}
			server.send(message);
		});
	});
	await page.reload();
	await showDecisions(page);
	let scope = decisionsCard(page, "Which of these belong in the first cut?");
	failing = await scope.getAttribute("data-plan-sidecar-questionnaire") ?? "";
	await decisionsCard(page).getByText("In SQLite", { exact: true }).click();
	await scope.getByText("Anchors", { exact: true }).click();
	await page.locator("[data-plan-decisions-scroll]").evaluate(element => {
		element.scrollTop = element.scrollHeight;
	});
	let region = page.getByRole("region", { name: "Unsaved answers" });
	await region.getByRole("button", { name: "Save", exact: true }).click();

	await expect(region.getByRole("alert")).toHaveText("Couldn’t save 1 answer");
	await expect(scope).toBeFocused();
	// The saved card's confirmation folds away above the failed one.
	await expect(page.locator("[data-decision-confirmed]")).toHaveCount(0, { timeout: 5_000 });
	await expect(page.getByRole("button", { name: "1 resolved" })).toBeVisible();
	await expect(scope.getByRole("heading", { name: "Which of these belong in the first cut?" }))
		.toBeInViewport();
	await expect(scope.getByText("The server could not save this decision.")).toBeInViewport();
});

test("phone: an open decision in the document is a chip that opens it in Decisions", async ({ join, seed }) => {
	await seed("Decisions on a phone.\n");
	let page = await join("ana", PHONE);
	let chip = page.getByRole("button", { name: `Decision: ${PROMPT}, answer in Decisions` });
	await expect(chip).toBeVisible();
	await expect(
		page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]'),
	).toHaveCount(0);
	let box = (await chip.boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(44);

	let id = await chip.getAttribute("data-plan-sidecar-questionnaire");
	await chip.click();
	await expect(
		page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Decisions/ }),
	).toHaveAttribute("aria-current", "page");
	await expect(
		page.locator(`[data-document-view="decisions"] [data-plan-sidecar-questionnaire="${id}"]`),
	).toBeFocused();
});

test("desktop keeps the in-card Save and the inline card", async ({ join, seed }) => {
	await seed("Decisions on a desktop.\n");
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await expect(
		page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]').first(),
	).toBeVisible();
	await expect(page.locator(".decision-chip")).toHaveCount(0);
	await showDecisions(page);
	let card = decisionsCard(page);
	await card.getByText("In SQLite", { exact: true }).click();
	await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	await expect(card.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
	await expect(page.locator(".decision-save-bar")).toHaveCount(0);
});
