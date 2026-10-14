import { authenticate, expect, ready, roomPath, test, written } from "./room";
import type { Page } from "@playwright/test";

const QUESTION = "How should onboarding work?";
const CONTEXT =
	"Help first-time collaborators understand decisions without interrupting their work.";
const ANSWER =
	"Start with a short example in the empty Decisions view.\nOffer a tour only when someone asks for help.";

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

async function create(page: Page) {
	let view = await decisions(page);
	await view.getByRole("button", { name: "New decision", exact: true }).click();
	await expect(view.getByRole("textbox", { name: "Decision question" })).toBeFocused();
	await view.getByRole("textbox", { name: "Decision question" }).fill(QUESTION);
	await view.getByRole("textbox", { name: "Context (optional)" }).fill(CONTEXT);
	await view.getByRole("button", { name: "Create decision", exact: true }).click();
	await expect(card(page).getByRole("textbox", { name: "Working answer" })).toBeVisible();
}

test(
	"people create, collaborate on and explicitly record a written decision, then reopen with history",
	async ({ join, room }, info) => {
		let ana = await join("ana");
		let ben = await join("ben");
		await create(ana);
		await decisions(ben);
		let first = card(ana);
		let second = card(ben);
		await expect(second).toContainText(CONTEXT);
		await expect(first.getByRole("button", { name: "Record decision", exact: true }))
			.toBeDisabled();
		await first.getByRole("textbox", { name: "Working answer" }).fill(ANSWER);
		await expect(second.getByRole("textbox", { name: "Working answer" })).toHaveValue(ANSWER);
		await expect(second).toContainText("Open");
		await first.getByRole("button", { name: "Add an approach", exact: true }).click();
		await first.getByRole("textbox", { name: "New approach" }).fill("A guided walkthrough");
		await first.getByRole("button", { name: "Add approach", exact: true }).click();
		await expect(second).toContainText("A guided walkthrough");
		await expect(second.getByRole("textbox", { name: "Working answer" })).toHaveValue(ANSWER);
		await expect(first.getByRole("radio")).toHaveCount(0);
		await first.screenshot({ path: info.outputPath("open-decision.png") });

		await ana.reload();
		await ready(ana);
		await decisions(ana);
		await expect(first.getByRole("textbox", { name: "Working answer" })).toHaveValue(ANSWER);
		await first.getByRole("button", { name: "Record decision", exact: true }).click();
		await expect(second).toContainText("Decided");
		await expect(second).toContainText("Decided by @ana");
		await expect(second.getByRole("textbox", { name: "Working answer" })).toHaveCount(0);
		await expect(second).toContainText("Offer a tour only when someone asks for help.");
		await written(ana, room, /response="text"/);
		await first.screenshot({ path: info.outputPath("decided-decision.png") });
		await second.getByRole("button", { name: "Reopen", exact: true }).click();
		await expect(first.getByRole("textbox", { name: "Working answer" })).toBeVisible();
		await expect(first).toContainText("Start with a short example");
		await second.getByRole("textbox", { name: "Working answer" }).fill(
			"Use contextual hints after the first decision.",
		);
		await second.getByRole("button", { name: "Record decision", exact: true }).click();
		await expect(first).toContainText("Decided by @ben");
		await expect(first).toContainText("Use contextual hints after the first decision.");
		await ben.reload();
		await ready(ben);
		await decisions(ben);
		await expect(second).toContainText("Use contextual hints after the first decision.");
		await second.getByRole("button", { name: "Discard", exact: true }).click();
		await second.getByRole("button", { name: "Discard decision", exact: true }).click();
		await expect(
			ana.locator('[data-document-view="decisions"] article')
				.filter({ hasText: QUESTION }),
		).toContainText("Discarded by @ben");
	},
);

test(
	"phone creation and working answers remain usable with the shared save bar",
	async ({ join }, info) => {
		let page = await join("ana", {
			hasTouch: true,
			isMobile: true,
			viewport: { width: 390, height: 844 },
		});
		await create(page);
		let decision = card(page);
		await decision.getByRole("textbox", { name: "Working answer" }).fill(ANSWER);
		let pending = page.getByRole("region", { name: "Unsaved answers" });
		await expect(pending).toBeVisible();
		await pending.getByRole("button", { name: "Record decision", exact: true }).click({
			trial: true,
		});
		await page.screenshot({ path: info.outputPath("phone-decision.png"), animations: "disabled" });
		await pending.getByRole("button", { name: "Clear", exact: true }).click();
		await expect(decision.getByRole("textbox", { name: "Working answer" })).toHaveValue("");
		await decision.getByRole("textbox", { name: "Working answer" }).fill(ANSWER);
		await pending.getByRole("button", { name: "Record decision", exact: true }).click();
		await expect(decision).toContainText("Decided by @ana");
		let overflowing = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		expect(overflowing).toBe(false);
	},
);

test("readers see an open decision but cannot create or record one", async ({ join, browser, baseURL, room }) => {
	let ana = await join("ana");
	await create(ana);
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		let view = await decisions(reader);
		await expect(view.getByRole("button", { name: "New decision", exact: true })).toHaveCount(0);
		await expect(card(reader).getByRole("textbox", { name: "Working answer" })).toBeDisabled();
		await expect(card(reader).getByRole("button", { name: "Record decision", exact: true }))
			.toHaveCount(0);
	} finally {
		await context.close();
	}
});
