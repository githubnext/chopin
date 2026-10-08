/** Browser coverage for evidence attached to a chat-derived decision card. */

import { expect, test } from "./room";
import { openJevWire, sendChat, wireFrames, wireState } from "./jev-wire";
import { resetPlannerJobs, scriptJob } from "./planner-jobs";

import type { Locator, Page } from "@playwright/test";

const QUESTION = "Should we ship a small pilot?";
const OPTION = "Start with a small pilot.";
const REASON = "A small pilot would catch setup problems early.";
const CONSTRAINT = "Keep the pilot accessible to keyboard-only users.";

function card(page: Page) {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: QUESTION, exact: true }) });
}

function evidence(page: Page) {
	return page.getByRole("dialog", { name: `Evidence for ${QUESTION}`, exact: true });
}

async function discuss(ana: Page, bo: Page, room: string) {
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, QUESTION);
	await sendChat(bo, OPTION);
	let reason = await sendChat(ana, REASON);
	await sendChat(bo, CONSTRAINT);
	await sendChat(ana, "I support the small pilot.");
	await sendChat(bo, "I object: a small pilot will exclude keyboard-only users.");
	await expect(card(ana)).toBeVisible();
	return reason;
}

async function openEvidence(page: Page): Promise<Locator> {
	await page.mouse.move(0, 0);
	await card(page).getByRole("button", { name: /^Evidence:/ })
		.click();
	let panel = evidence(page);
	await expect(panel).toBeVisible();
	return panel;
}

test.beforeEach(async () => {
	await resetPlannerJobs();
});

test.afterEach(async () => {
	await resetPlannerJobs();
});

test("a card stays quiet on hover and evidence opens only by its summary", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await discuss(ana, bo, room);

	await card(ana).hover();
	await ana.waitForTimeout(450);
	await expect(evidence(ana)).toHaveCount(0);
	let trigger = card(ana).getByRole("button", { name: /^Evidence:/ });
	await trigger.focus();
	await expect(evidence(ana)).toHaveCount(0);
	await trigger.press("Enter");
	let panel = evidence(ana);
	await expect(panel).toBeVisible();
	await ana.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(trigger).toBeFocused();

	panel = await openEvidence(ana);
	let box = await panel.boundingBox();
	let cardBox = await card(ana).boundingBox();
	expect(box).toBeTruthy();
	expect(cardBox).toBeTruthy();
	expect(
		box!.x >= cardBox!.x + cardBox!.width || box!.x + box!.width <= cardBox!.x,
	).toBe(true);
	await ana.mouse.click(0, 0);
	await expect(panel).toHaveCount(0);
});

test("evidence shows exact sources and current stances, then source navigation can reopen and leave", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let reason = await discuss(ana, bo, room);
	await expect(card(ana).getByRole("button", { name: /^Evidence:/ })).toHaveText(
		"Evidence:1 reason·1 constraint·1 objection",
	);
	let panel = await openEvidence(ana);
	await expect(panel.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
	await expect(panel).toContainText(REASON);
	await expect(panel).toContainText(CONSTRAINT);
	await expect(panel).toContainText("Objection");
	await expect(panel).toContainText("a small pilot will exclude keyboard-only users.");
	await expect(panel).toContainText("Supported by ana");
	await expect(panel).toContainText("Opposed by bo");
	await expect(panel.locator("input, select, textarea")).toHaveCount(0);

	let source = panel.getByRole("button", { name: `Show “${REASON}” in chat`, exact: true });
	await source.focus();
	await expect(source).toBeFocused();
	await ana.mouse.move(0, 0);
	await ana.waitForTimeout(200);
	await expect(panel).toBeVisible();
	await expect(source).toBeFocused();
	await source.click();
	await expect(ana.locator(`[data-chat-message-id="${reason}"][data-source-exact="true"]`))
		.toBeVisible();
	await expect.poll(() => ana.evaluate(() => CSS.highlights.get("conversation-source")?.size ?? 0))
		.toBe(1);

	panel = await openEvidence(ana);
	await panel.hover();
	await ana.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	panel = await openEvidence(ana);
	await ana.mouse.click(0, 0);
	await expect(panel).toHaveCount(0);
});

test("source navigation yields scrolling to the reader and expires its highlight", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 775, height: 600 } });
	let bo = await join("bo");
	let reason = await discuss(ana, bo, room);
	await sendChat(
		bo,
		Array.from(
			{ length: 16 },
			(_, index) => `A later conversation note ${index + 1} gives the chat room to scroll.`,
		).join("\n\n"),
	);

	let panel = await openEvidence(ana);
	await panel.getByRole("button", { name: `Show “${REASON}” in chat`, exact: true }).click();
	let message = ana.locator(`[data-chat-message-id="${reason}"]`);
	await expect(message).toHaveAttribute("data-source-exact", "true");
	await expect(message).toBeInViewport();
	await expect(message).toHaveAttribute("data-chat-source", "true");
	await expect.poll(() => ana.evaluate(() => CSS.highlights.get("conversation-source")?.size ?? 0))
		.toBe(1);

	let scroller = ana.locator("[data-chat-stack]").locator("..");
	await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight))
		.toBeGreaterThan(100);
	await scroller.evaluate(element => element.scrollTop = element.scrollHeight);
	let manualTop = await scroller.evaluate(element => element.scrollTop);
	await expect(message).not.toBeInViewport();
	await sendChat(bo, "A final update arrives after I scroll away from the source.");
	await expect(ana.getByText("A final update arrives after I scroll away from the source.", {
		exact: true,
	})).toBeVisible();
	await expect.poll(() => scroller.evaluate(element => element.scrollTop))
		.toBeGreaterThanOrEqual(manualTop - 2);
	await expect(message).not.toBeInViewport();

	await expect(message).not.toHaveAttribute("data-source-exact", "true", { timeout: 8_000 });
	await expect(message).not.toHaveClass(/bg-inset/);
	await expect(message).not.toHaveAttribute("data-chat-source", "true");
	await expect.poll(() => ana.evaluate(() => CSS.highlights.get("conversation-source")?.size ?? 0))
		.toBe(0);
});

test("on a phone, evidence opens as a sheet that leaves the card's actions clear", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 390, height: 844 } });
	let bo = await join("bo");
	await discuss(ana, bo, room);
	let summary = card(ana).getByRole("button", { name: /^Evidence:/ });
	await summary.scrollIntoViewIfNeeded();
	let panel = await openEvidence(ana);
	await expect(panel).toHaveAttribute("data-side", "sheet");
	await expect.poll(async () => {
		let [sheet, actions] = await Promise.all([panel.boundingBox(), summary.boundingBox()]);
		return !!sheet && !!actions && actions.y + actions.height <= sheet.y;
	}).toBe(true);
	await ana.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(summary).toBeFocused();
});

test("a narrow panel closes without stale hover after Source or Escape", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 775, height: 863 } });
	let bo = await join("bo");
	await discuss(ana, bo, room);
	let panel = await openEvidence(ana);
	let source = panel.getByRole("button", { name: `Show “${REASON}” in chat`, exact: true });
	let [sourceBox, panelBox] = await Promise.all([source.boundingBox(), panel.boundingBox()]);
	expect(sourceBox).toBeTruthy();
	expect(panelBox).toBeTruthy();
	expect(panelBox!.x).toBeGreaterThanOrEqual(0);
	expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(775);
	expect(sourceBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
	expect(sourceBox!.x + sourceBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
	await source.click();
	await expect(panel).toHaveCount(0);
	await ana.waitForTimeout(450);
	await expect(panel).toHaveCount(0);

	await ana.getByRole("button", { name: "Document", exact: true }).click();
	await expect(card(ana)).toBeVisible();
	await ana.mouse.move(0, 0);
	panel = await openEvidence(ana);
	panelBox = await panel.boundingBox();
	expect(panelBox).toBeTruthy();
	await ana.mouse.move(panelBox!.x + panelBox!.width / 2, panelBox!.y + panelBox!.height / 2);
	await ana.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await ana.waitForTimeout(450);
	await expect(panel).toHaveCount(0);

	await ana.mouse.move(0, 0);
	await expect(await openEvidence(ana)).toBeVisible();
});

test("an open panel updates to the room's current stance", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, QUESTION);
	await sendChat(bo, OPTION);
	await sendChat(ana, "I support the small pilot.");
	let panel = await openEvidence(ana);
	await expect(panel).toContainText("Supported by ana");

	await sendChat(bo, "I support the small pilot.");
	await expect(panel).toContainText("Supported by ana, bo");
	await sendChat(bo, "I object: a small pilot will exclude keyboard-only users.");
	await expect(panel).toContainText("Supported by ana");
	await expect(panel).toContainText("Opposed by bo");
	await expect(panel).not.toContainText("Supported by ana, bo");
});

test("Planner option evidence navigates to its exact saved chat source", async ({ join, room }) => {
	let ana = await join("ana");
	await openJevWire(ana, room);
	let sourceQuote = "Start with a small pilot.";
	let sourceId = await sendChat(ana, sourceQuote);
	await expect.poll(async () =>
		(await wireState(ana))?.analysis.find(item => item.messageId === sourceId)?.status
	).toBe("unlinked");
	let source = {
		messageId: sourceId,
		author: { kind: "member", handle: "ana" },
		quote: sourceQuote,
		start: 0,
		end: sourceQuote.length,
		role: "option",
	};
	await scriptJob("refine", [{
		tool: "refine_decision",
		args: {
			revision: "$revision",
			id: "$target",
			title: "Should we run a limited pilot?",
			add_options: [
				{
					label: sourceQuote,
					rationale: "It keeps the pilot small and concrete.",
					source,
				},
				{
					label: "Pilot with two teams",
					rationale: "It compares two different settings.",
				},
			],
		},
	}]);
	await sendChat(ana, QUESTION);
	let refined = ana.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({
			has: ana.getByRole("heading", { name: "Should we run a limited pilot?", exact: true }),
		});
	await expect(refined.getByRole("radio", { name: sourceQuote, exact: true }))
		.toBeVisible();
	await expect(refined.getByRole("radio", { name: "Pilot with two teams", exact: true }))
		.toBeVisible();
	await expect.poll(async () => {
		let meta = (await wireFrames(ana)).findLast(frame => frame.kind === "question:meta")?.meta as
			| { optionOrigins: Record<string, { origin: string; rationale?: string; source?: unknown }> }
			| undefined;
		return Object.values(meta?.optionOrigins ?? {}).find(origin => origin.source)?.source;
	}).toEqual(source);
	await refined.getByRole("button", { name: /^Evidence:/ }).click();
	let panel = ana.getByRole("dialog", {
		name: "Evidence for Should we run a limited pilot?",
		exact: true,
	});
	await expect(panel).toContainText("Planner suggested");
	await expect(panel).toContainText(
		"Why Chopin suggested this: It keeps the pilot small and concrete.",
	);
	await expect(panel).toContainText(
		"Why Chopin suggested this: It compares two different settings.",
	);
	let showSource = panel.getByRole("button", {
		name: `Show “${sourceQuote}” in chat`,
		exact: true,
	});
	await expect(showSource).toBeVisible();
	await expect(panel.getByRole("button", { name: /Show .* in chat/ })).toHaveCount(1);
	await showSource.click();
	let sourceMessage = ana.locator(`[data-chat-message-id="${sourceId}"]`);
	await expect(sourceMessage).toHaveAttribute("data-source-exact", "true");
	await expect(sourceMessage).toBeInViewport();
	await expect(sourceMessage).toHaveAttribute("data-chat-source", "true");
	await expect.poll(() => ana.evaluate(() => CSS.highlights.get("conversation-source")?.size ?? 0))
		.toBe(1);
});

test("a long panel clamps to a short viewport and keeps its own scrollable evidence reachable", async ({ join, room }) => {
	let rationale = "This option keeps the pilot concrete while collecting useful delivery evidence. "
		.repeat(3).trim();
	await scriptJob("refine", [{
		tool: "refine_decision",
		args: {
			revision: "$revision",
			id: "$target",
			add_options: Array.from({ length: 5 }, (_, index) => ({
				label: `Pilot cohort ${index + 1}`,
				rationale,
			})),
		},
	}]);
	let ana = await join("ana", { viewport: { width: 800, height: 360 } });
	await openJevWire(ana, room);
	await sendChat(ana, QUESTION);
	await expect(card(ana).getByRole("radio", { name: "Pilot cohort 5", exact: true })).toBeVisible();
	let panel = await openEvidence(ana);
	let box = await panel.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(800);
	expect(box!.y + box!.height).toBeLessThanOrEqual(360);

	let contents = panel.getByLabel("Evidence", { exact: true });
	await expect.poll(() => contents.evaluate(element => element.scrollHeight > element.clientHeight))
		.toBe(true);
	await contents.evaluate(element => element.scrollTop = element.scrollHeight);
	expect(await contents.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect(panel).toBeVisible();
	await ana.setViewportSize({ width: 500, height: 360 });
	await expect.poll(() => ana.evaluate(() => innerWidth)).toBe(500);
	await expect.poll(async () => {
		let current = await panel.boundingBox();
		return current ? current.x + current.width : Number.POSITIVE_INFINITY;
	}).toBeLessThanOrEqual(500);
	box = await panel.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(500);
});

test("scrolling the document closes its evidence panel", async ({ join, room, seed }) => {
	await seed(
		Array.from({ length: 80 }, (_, index) => `Document paragraph ${index + 1}.`).join("\n\n"),
	);
	let ana = await join("ana");
	let bo = await join("bo");
	await discuss(ana, bo, room);
	let panel = await openEvidence(ana);
	let scroller = ana.locator("[data-plan-scroll]");
	let top = await scroller.evaluate(element => element.scrollTop);
	expect(top).toBeGreaterThan(0);
	await scroller.evaluate(element => element.scrollTo({ top: 0 }));
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
	await expect(panel).toHaveCount(0);
});

test("empty, remote-closed, and hidden-document cards do not retain evidence portals", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, QUESTION);
	await sendChat(bo, OPTION);
	await expect(card(ana)).toBeVisible();
	await card(ana).hover();
	await ana.waitForTimeout(600);
	await expect(evidence(ana)).toHaveCount(0);

	await sendChat(ana, REASON);
	let panel = await openEvidence(ana);
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	await expect(panel).toHaveCount(0);
	await ana.getByRole("button", { name: "Document", exact: true }).click();
	panel = await openEvidence(ana);
	await bo.getByRole("button", { name: /^Decisions/ }).click();
	let remote = bo.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ has: bo.getByRole("heading", { name: QUESTION, exact: true }) });
	await remote.getByText(OPTION, { exact: true }).click();
	await remote.getByRole("button", { name: "Save", exact: true }).click();
	await expect(panel).toHaveCount(0);

	await ana.getByRole("button", { name: "Decisions", exact: true }).click();
	await ana.getByRole("button", { name: "1 resolved", exact: true }).click();
	let resolved = ana.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	).filter({ hasText: QUESTION });
	await expect(resolved).toBeVisible();
	await resolved.getByRole("button", { name: "Reopen", exact: true }).click();
	await ana.getByRole("button", { name: "Document", exact: true }).click();
	await expect(card(ana)).toBeVisible();
	panel = await openEvidence(ana);
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	await expect(panel).toHaveCount(0);
	let listed = ana.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	).filter({ has: ana.getByRole("heading", { name: QUESTION, exact: true }) });
	await listed.hover();
	await ana.waitForTimeout(450);
	await expect(evidence(ana)).toHaveCount(0);
	await listed.getByRole("button", { name: /^Evidence:/ }).click();
	await expect(evidence(ana)).toBeVisible();
	await expect(evidence(ana)).toContainText(REASON);
});

test("a remote discard removes an open evidence portal", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await discuss(ana, bo, room);
	let panel = await openEvidence(ana);
	await bo.getByRole("button", { name: /^Decisions/ }).click();
	let remote = bo.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ has: bo.getByRole("heading", { name: QUESTION, exact: true }) });
	await remote.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(remote.getByText("Discard this decision?", { exact: true })).toBeVisible();
	await remote.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(panel).toHaveCount(0);
});
