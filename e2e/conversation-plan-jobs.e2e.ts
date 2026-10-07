import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { openJevWire, sendChat, wireFrames, wireRequest } from "./jev-wire";
import { releasePlannerJob, resetPlannerJobs, scriptJob } from "./planner-jobs";

import type { Page } from "@playwright/test";

const QUESTION = "Should we ship a small pilot?";
const REFINED = "Should we run a limited pilot?";
const EXISTING_OPTION = "Start with a small pilot.";
const OPTION = "Pilot with one team";

function card(page: Page, question = QUESTION) {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: question, exact: true }) });
}

function message(page: Page, messageId: string) {
	return page.locator(`[data-chat-message-id="${messageId}"]`);
}

function inspection(page: Page, messageId: string) {
	return message(page, messageId).getByRole("button", { name: /Message details/ });
}

function jobs(page: Page) {
	return page.getByLabel("Message analysis");
}

async function waitForCard(page: Page) {
	await expect(card(page)).toBeVisible();
	return card(page);
}

async function waitForRefine(page: Page, messageId: string, status: string) {
	await waitForJob(page, messageId, status);
	let marker = inspection(page, messageId);
	if (await marker.getAttribute("aria-expanded") !== "true") {
		await marker.focus();
		await marker.press("Enter");
	}
	await expect(marker).toHaveAttribute("aria-expanded", "true");
	let popoverId = await marker.getAttribute("aria-controls");
	if (!popoverId) throw new Error("analysis marker did not identify its popover");
	let diagnostics = page.locator(`[id="${popoverId}"] details`);
	if (!await diagnostics.evaluate(element => (element as HTMLDetailsElement).open)) {
		await diagnostics.getByText("Diagnostics", { exact: true }).click();
	}
	await expect(page.locator(`[id="${popoverId}"]`).getByRole("group", { name: "Planner jobs" }))
		.toContainText(`refine · ${status}`);
}

async function job(page: Page, messageId: string) {
	let frames = await wireFrames(page);
	let latest = frames.findLast(frame =>
		frame.kind === "conversation-plan:jobs" || frame.kind === "conversation-plan:snapshot"
	);
	let values = latest?.jobs;
	return Array.isArray(values)
		? values.find(item =>
			item && typeof item === "object"
			&& (item as { kind?: unknown }).kind === "refine"
			&& (item as { trigger?: unknown }).trigger === messageId
		)
		: undefined;
}

async function waitForJob(page: Page, messageId: string, status: string) {
	await expect.poll(async () =>
		(await job(page, messageId) as { status?: string } | undefined)?.status
	)
		.toBe(status);
	return (await job(page, messageId)) as { id: string; status: string };
}

async function releaseHeldRefine(page: Page, messageId: string) {
	await releasePlannerJob("refine");
	await expect.poll(async () =>
		(await job(page, messageId) as { status?: string } | undefined)?.status
	)
		.toMatch(/^(done|failed|skipped)$/);
}

async function expectPopoverInChat(page: Page) {
	let [popover, chat, composer] = await Promise.all([
		page.getByLabel("Message analysis").boundingBox(),
		page.getByRole("complementary", { name: "Chat" }).boundingBox(),
		page.locator(".chat-composer").boundingBox(),
	]);
	expect(popover).not.toBeNull();
	expect(chat).not.toBeNull();
	expect(composer).not.toBeNull();
	expect(popover!.x).toBeGreaterThanOrEqual(chat!.x);
	expect(popover!.x + popover!.width).toBeLessThanOrEqual(chat!.x + chat!.width);
	expect(popover!.y + popover!.height).toBeLessThanOrEqual(composer!.y);
}

async function headerAction(page: Page, action: "Archive" | "Restore") {
	await page.getByRole("banner").getByRole("button", { name: /^Actions for / }).click();
	await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function refineScript(options: { hold?: boolean; target?: string } = {}) {
	await scriptJob("refine", [{
		tool: "refine_decision",
		args: {
			revision: "$revision",
			id: options.target ?? "$target",
			title: REFINED,
			add_options: [{ label: OPTION, rationale: "It keeps the pilot small and concrete." }],
		},
	}], { hold: options.hold });
}

test.beforeEach(async () => {
	await resetPlannerJobs();
});

test.afterEach(async () => {
	await resetPlannerJobs();
});

test("both collaborators see a held refining card before the completed job writes its activity", async ({ join, room }) => {
	await refineScript({ hold: true });
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	let messageId: string | undefined;
	try {
		messageId = await sendChat(ana, QUESTION);

		for (let page of [ana, bo]) {
			let decision = await waitForCard(page);
			let status = decision.getByRole("status");
			await expect(status).toBeVisible();
			await expect(status).toHaveText("Chopin is refining…");
			await expect(decision.locator('[data-refining="true"]')).toHaveCount(1);
		}
		await waitForRefine(ana, messageId, "running");
		await waitForRefine(bo, messageId, "running");
		await sendChat(ana, EXISTING_OPTION);
		let existing = card(ana).getByRole("radio", { name: EXISTING_OPTION, exact: true });
		await card(ana).getByText(EXISTING_OPTION, { exact: true }).click();
		await expect(existing).toBeChecked();
		await expect(card(bo).getByRole("radio", { name: EXISTING_OPTION, exact: true }))
			.toBeChecked();

		await releaseHeldRefine(ana, messageId);
		for (let page of [ana, bo]) {
			let decision = card(page, REFINED);
			await expect(decision).toBeVisible();
			await expect(decision.getByRole("radio", { name: EXISTING_OPTION, exact: true }))
				.toBeChecked();
			await expect(decision.getByRole("radio", { name: OPTION, exact: true })).toBeVisible();
			await expect(decision.getByText("Chopin is refining…", { exact: true })).toHaveCount(0);
			await expect(page.getByText(`Chopin refined ${REFINED}`, { exact: true })).toBeVisible();
		}
		await waitForRefine(ana, messageId, "done");
		await waitForRefine(bo, messageId, "done");
	} finally {
		if (messageId) await releaseHeldRefine(ana, messageId);
	}
});

test("an unscripted refine failure remains inspectable while its card accepts a selection", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, QUESTION);
	let decision = await waitForCard(page);
	await sendChat(page, EXISTING_OPTION);
	await expect(decision.getByRole("radio", { name: EXISTING_OPTION, exact: true }))
		.toBeVisible();
	await decision.getByText(EXISTING_OPTION, { exact: true }).click();
	await expect(decision.getByRole("radio", { name: EXISTING_OPTION, exact: true }))
		.toBeChecked();

	await waitForRefine(page, messageId, "failed");
	await expect(jobs(page)).toContainText(/ENOENT.*refine\.json/);
});

test("failed jobs survive reload, keep diagnostics in place, and retry with the corrected script", async ({ join, room }) => {
	await refineScript({ target: "not-this-card" });
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, QUESTION);
	await waitForCard(page);
	let chatMessage = message(page, messageId);
	let transcript = chatMessage.locator("xpath=ancestor::*[@data-focus-boundary][1]");
	let before = await chatMessage.boundingBox();
	let scrollTop = await transcript.evaluate(element => element.scrollTop);
	await waitForRefine(page, messageId, "failed");
	let after = await chatMessage.boundingBox();
	expect(before).not.toBeNull();
	expect(after).not.toBeNull();
	expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
	expect(await transcript.evaluate(element => element.scrollTop)).toBe(scrollTop);
	await expectPopoverInChat(page);
	await expect(jobs(page).getByRole("button", { name: "Retry refine job", exact: true }))
		.toBeVisible();

	await page.reload();
	await ready(page);
	await openJevWire(page, room);
	await waitForRefine(page, messageId, "failed");
	await waitForJob(page, messageId, "failed");
	await refineScript();
	await jobs(page).getByRole("button", { name: "Retry refine job", exact: true }).click();
	await expect(jobs(page)).toContainText("refine · done");
	await expect(card(page, REFINED)).toBeVisible();
});

test("an archived held job becomes interrupted and retries only after the document is restored", async ({ join, room }) => {
	await refineScript({ hold: true });
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId: string | undefined;
	try {
		messageId = await sendChat(page, QUESTION);
		await waitForCard(page);
		await waitForRefine(page, messageId, "running");

		await headerAction(page, "Archive");
		await expect(content(page)).toHaveAttribute("contenteditable", "false");
		await headerAction(page, "Restore");
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
		await page.reload();
		await ready(page);
		await openJevWire(page, room);
		await waitForRefine(page, messageId, "failed");
		await waitForJob(page, messageId, "failed");
		await expect(jobs(page)).toContainText("interrupted");
		await expect(page.getByText(`Chopin refined ${REFINED}`, { exact: true })).toHaveCount(0);

		await refineScript();
		await jobs(page).getByRole("button", { name: "Retry refine job", exact: true }).click();
		await expect(jobs(page)).toContainText("refine · done");
		await expect(card(page, REFINED)).toBeVisible();
	} finally {
		if (messageId) await releaseHeldRefine(page, messageId);
	}
});

test("read-only collaborators cannot retry a failed Planner job", async ({ baseURL, browser, join, room }) => {
	await refineScript({ target: "not-this-card" });
	let writer = await join("ana");
	await openJevWire(writer, room);
	let messageId = await sendChat(writer, QUESTION);
	await waitForCard(writer);
	await waitForRefine(writer, messageId, "failed");

	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await openJevWire(reader, room);
		await waitForRefine(reader, messageId, "failed");
		await expect(jobs(reader).getByRole("button", { name: "Retry refine job", exact: true }))
			.toHaveCount(0);
		let failed = await waitForJob(reader, messageId, "failed");
		let frame = await wireRequest(reader, {
			kind: "conversation-plan:retry-job",
			jobId: failed.id,
		});
		expect(frame).toMatchObject({
			kind: "session:error",
			message: expect.stringMatching(/write access/),
		});
	} finally {
		await context.close();
	}
});
