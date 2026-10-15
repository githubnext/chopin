import { expect, test } from "@playwright/test";

import { load, prepareAgenda } from "./agenda-native";
import { response } from "./agenda.fixture";

test.beforeAll(prepareAgenda);

test("empty scope is saved before one explicit bounded allowance", async ({ page }) => {
	let paused = response("paused");
	paused.agenda!.revision = 1;
	paused.agenda!.questions = [];
	let active = { ...paused, agenda: { ...paused.agenda!, state: "active" as const, revision: 2 } };
	let fixture = await load(page, response(null), async route => {
		if (route.request().method() === "PUT") {
			await route.fulfill({ json: paused });
			return true;
		}
		if (route.request().url().endsWith("/activate")) {
			await route.fulfill({ json: active });
			return true;
		}
		return false;
	});
	let allow = page.getByRole("button", { name: "Allow public research", exact: true });
	await expect(allow).toBeDisabled();
	let scope = "Explore public examples of discovering and learning open decisions.";
	await page.getByRole("textbox", { name: "Public research scope", exact: true }).fill(scope);
	await page.getByRole("button", { name: "What is allowed", exact: true }).click();
	await expect(page.getByText(/Up to 14 AI sessions, including planning and retries/))
		.toBeVisible();
	await expect(page.getByText(/AI credits/)).toHaveCount(0);
	await expect(page.getByText("Document text and repository files stay outside that worker."))
		.toBeVisible();
	await allow.click();
	await expect(page.getByRole("button", { name: "Pause research", exact: true })).toBeVisible();
	expect(fixture.mutations.map(item => ({ method: item.method, body: item.body }))).toEqual([
		{ method: "PUT", body: { expectedRevision: 0, scope, questions: [] } },
		{ method: "POST", body: { expectedRevision: 1 } },
	]);
	expect(fixture.errors).toEqual([]);
});

test(
	"active agenda inspects real questions and pauses the current grant despite progress revisions",
	async ({ page }, testInfo) => {
		let paused = response("paused");
		paused.agenda!.revision = 4;
		paused.agenda!.stopReason = "human-paused";
		let fixture = await load(page, response(), async route => {
			if (!route.request().url().endsWith("/pause")) return false;
			await route.fulfill({ json: paused });
			return true;
		});
		await page.getByRole("button", {
			name: "How do other editors introduce open decisions?",
			exact: true,
		}).click();
		await expect(page.getByText("Help people find the next useful choice.", { exact: true }))
			.toBeVisible();
		await expect(page.getByText("High priority", { exact: true })).toBeVisible();
		let disclosure = page.getByRole("button", { name: "What is allowed", exact: true });
		await disclosure.click();
		await expect(page.getByText(/Up to 14 AI sessions, including planning and retries/))
			.toBeVisible();
		await expect(page.getByText("4 sessions reserved. Failed attempts count.", { exact: true }))
			.toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		let panelId = await disclosure.getAttribute("aria-controls");
		let panel = page.locator(`[id="${panelId}"]`);
		await expect(panel).not.toHaveAttribute("data-starting-style", "");
		await expect.poll(() =>
			panel.evaluate(element => element.getAnimations({ subtree: true }).length)
		)
			.toBe(0);
		let screenshot = testInfo.outputPath("agenda-desktop.png");
		await page.screenshot({ path: screenshot, animations: "disabled" });
		await testInfo.attach("Research agenda desktop", {
			path: screenshot,
			contentType: "image/png",
		});
		await page.getByRole("button", { name: "Pause research", exact: true }).click();
		await expect(page.getByText("Paused. Running research has been cancelled.", { exact: true }))
			.toBeVisible();
		expect(fixture.mutations).toHaveLength(1);
		expect(fixture.mutations[0].body).toEqual({ expectedGeneration: 1 });
		expect(fixture.errors).toEqual([]);
	},
);

test("readers inspect linked reports and cannot change the agenda", async ({ page }) => {
	let readonly = response("stopped");
	readonly.canEdit = false;
	readonly.agenda!.stopReason = "evidence-sufficient";
	readonly.agenda!.questions[0].state = "completed";
	readonly.agenda!.questions[0].request = {
		id: "request-a",
		channelId: "document-a",
		question: "Open decisions",
		sources: [],
		createdAt: "2026-10-14T06:00:00.000Z",
		updatedAt: "2026-10-14T06:01:00.000Z",
		state: "completed",
		stage: "ready",
		child: {
			id: "child-a",
			title: "Introducing open decisions",
			slug: "open-decisions",
			summary: "Documented public examples.",
			sourceCount: 3,
		},
	};
	let fixture = await load(page, readonly);
	await expect(
		page.getByText("Stopped because there is enough evidence for this scope.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Edit scope and questions", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Pause research", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Allow public research", exact: true }))
		.toHaveCount(0);
	await page.evaluate(() => window.agendaFixture.openReport = false);
	await page.getByRole("button", { name: "Introducing open decisions", exact: true }).click();
	await expect(page.getByText("Could not open the report. Try its title again.", { exact: true }))
		.toBeVisible();
	await page.evaluate(() => window.agendaFixture.openReport = true);
	await page.getByRole("button", { name: "Introducing open decisions", exact: true }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await page.evaluate(() => window.agendaFixture.opened)).toEqual(["child-a", "child-a"]);
	expect(fixture.mutations).toEqual([]);
	expect(fixture.errors).toEqual([]);
});

test("unavailable research names the reason and prevents activation", async ({ page }) => {
	let unavailable = response("paused");
	unavailable.available = false;
	unavailable.unavailableReason = "Research agendas are unavailable with the remote Planner.";
	let fixture = await load(page, unavailable);
	await expect(page.getByText(unavailable.unavailableReason, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Allow public research", exact: true }))
		.toBeDisabled();
	expect(fixture.mutations).toEqual([]);
});

test("scope conflicts retain edits until an explicit save against the latest revision", async ({ page }) => {
	let latest = response("paused");
	latest.agenda!.revision = 4;
	latest.agenda!.scope =
		"Explore a different public onboarding question supplied by another writer.";
	let writes = 0;
	let fixture = await load(page, response("paused"), async route => {
		if (route.request().method() === "PUT") {
			writes++;
			if (writes === 1) {
				await route.fulfill({ status: 409, json: { error: "raw provider secret" } });
			} else {await route.fulfill({
					json: { ...latest, agenda: { ...latest.agenda!, revision: 5 } },
				});}
			return true;
		}
		if (writes > 0) {
			await route.fulfill({ json: latest });
			return true;
		}
		return false;
	});
	await page.getByRole("button", { name: "Edit scope and questions", exact: true }).click();
	let scope = page.getByRole("textbox", { name: "Public research scope", exact: true });
	let edited = "Explore public research about introducing decisions through direct interaction.";
	await scope.fill(edited);
	await page.getByRole("button", { name: "Save paused", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("The agenda changed while you were editing.");
	await expect(scope).toHaveValue(edited);
	await expect(page.getByText("raw provider secret")).toHaveCount(0);
	await page.getByRole("button", { name: "Save my edits", exact: true }).click();
	await expect(page.getByRole("button", { name: "Edit scope and questions", exact: true }))
		.toBeVisible();
	expect(fixture.mutations.map(item => item.body.expectedRevision)).toEqual([3, 4]);
	expect(fixture.mutations[1].body.scope).toBe(edited);
	expect(fixture.errors).toEqual([]);
});

test("polls preserve local question edits and ignore a response superseded by pause", async ({ page }) => {
	let reads = 0;
	let release!: () => void;
	let staleRead = new Promise<void>(resolve => release = resolve);
	let paused = response("paused");
	paused.agenda!.revision = 4;
	paused.agenda!.stopReason = "human-paused";
	let fixture = await load(page, response(), async route => {
		if (route.request().method() === "GET") {
			reads++;
			if (reads === 2) {
				await staleRead;
				await route.fulfill({ json: response() }).catch(() => {});
				return true;
			}
		}
		if (route.request().url().endsWith("/pause")) {
			await route.fulfill({ json: paused });
			return true;
		}
		if (route.request().method() === "PUT") {
			await route.fulfill({ json: { ...paused, agenda: { ...paused.agenda!, revision: 5 } } });
			return true;
		}
		return false;
	});
	await page.getByRole("button", { name: "Edit scope and questions", exact: true }).click();
	await page.getByRole("button", {
		name: "How do other editors introduce open decisions?",
		exact: true,
	}).click();
	let evidence = page.getByRole("textbox", { name: "Evidence needed", exact: true });
	await evidence.fill("Publicly documented examples of direct interaction.");
	await page.clock.install();
	await page.clock.fastForward(5100);
	await expect.poll(() => reads).toBe(2);
	await expect(evidence).toHaveValue("Publicly documented examples of direct interaction.");
	await page.getByRole("button", { name: "Pause research", exact: true }).click();
	await expect(page.getByText("Paused. Running research has been cancelled.", { exact: true }))
		.toBeVisible();
	release();
	await expect(page.getByRole("button", { name: "Pause research", exact: true })).toHaveCount(0);
	await expect(evidence).toHaveValue("Publicly documented examples of direct interaction.");
	await page.getByRole("button", { name: "Save paused", exact: true }).click();
	await expect(page.getByRole("button", { name: "Edit scope and questions", exact: true }))
		.toBeVisible();
	expect(fixture.mutations.at(-1)!.body.expectedRevision).toBe(4);
	expect(fixture.errors).toEqual([]);
});

test("native keyboard focus is trapped and Escape restores the opener", async ({ page }) => {
	let fixture = await load(page, response(null));
	let dialog = page.getByRole("dialog", { name: "Research agenda", exact: true });
	await page.getByRole("button", { name: "Done", exact: true }).focus();
	await page.keyboard.press("Tab");
	expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
		true,
	);
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByRole("button", { name: "Done", exact: true })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Research agenda", exact: true })).toBeFocused();
	expect(fixture.errors).toEqual([]);
});

test(
	"narrow native layout contains long questions, edits, and delegation controls",
	async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 360, height: 640 });
		let initial = response("paused");
		initial.agenda!.questions[0].question =
			"How do collaborative writing tools help people discover and use open decisions?";
		let fixture = await load(page, initial);
		await page.getByRole("button", { name: "Edit scope and questions", exact: true }).click();
		await page.getByRole("button", { name: initial.agenda!.questions[0].question, exact: true })
			.click();
		await page.getByRole("button", { name: "What is allowed", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Research agenda", exact: true });
		let box = await dialog.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(360);
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(640);
		expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.getByRole("button", { name: "Cancel edits", exact: true }).click();
		await page.locator(".agenda-body").evaluate(element => element.scrollTop = 0);
		await page.evaluate(() => document.fonts.ready);
		let screenshot = testInfo.outputPath("agenda-narrow.png");
		await page.screenshot({ path: screenshot });
		await testInfo.attach("Research agenda narrow", { path: screenshot, contentType: "image/png" });
		expect(fixture.errors).toEqual([]);
	},
);
