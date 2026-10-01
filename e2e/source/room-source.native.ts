import { expect, test } from "@playwright/test";
import { load, meta, prepareRoomSource, select, thread } from "./room-source-native";
test.beforeAll(prepareRoomSource);

test("actual host evidence requires current metadata and sources enter actual Chat", async ({ page }) => {
	let errors = await load(page);
	await page.evaluate(thread => {
		window.roomSourceProbe.setQuestions({
			hasPlanContent: true,
			entries: [{
				id: "card-1",
				value: {
					id: "card-1",
					thread: "thread-1",
					questions: [{
						id: "q1",
						header: "Rollout",
						prompt: "Choose rollout",
						multiple: false,
						options: [{ id: "o1", label: "Pilot" }],
					}],
				},
			}],
		});
		window.roomSourceProbe.receive({
			kind: "conversation-plan:snapshot",
			state: {
				schemaVersion: 1,
				revision: 1,
				events: [],
				threads: [thread],
				queue: [],
				analysis: [],
			},
			jobs: [],
			ts: 1,
		});
	}, thread);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.evidence("card-1"))).toBe(
		null,
	);
	await page.evaluate(
		meta => window.roomSourceProbe.receive({ kind: "question:meta", id: "card-1", meta, ts: 1 }),
		meta,
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.evidence("card-1")?.type))
		.toBe("EvidencePopover");
	await page.evaluate(() => window.roomSourceProbe.renderEvidence("card-1"));
	await page.getByRole("button", { name: "Show “pilot” in chat", exact: true }).click();
	await expect(page.locator('[data-chat-message-id="m1"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	await page.evaluate(
		meta =>
			window.roomSourceProbe.receive({
				kind: "question:meta",
				id: "card-1",
				meta: { ...meta, status: "decided" },
				ts: 2,
			}),
		meta,
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.evidence("card-1"))).toBe(
		null,
	);
	expect(await page.evaluate(() => window.roomSourceProbe.evidence("missing"))).toBe(null);
	expect(errors).toEqual([]);
});
test("real3000ms expiry cannot clear the replacement near the first deadline", async ({ page }) => {
	let errors = await load(page);
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
	await select(page, "m1");
	let first = await page.evaluate(() => window.roomSourceProbe.snapshot().destination!.token);
	await page.clock.runFor(2900);
	await select(page, "m2");
	expect(await page.evaluate(() => window.roomSourceProbe.snapshot().destination!.token))
		.toBeGreaterThan(first);
	expect(await page.evaluate(() => window.roomSourceProbe.expiries.length)).toBe(2);
	await page.evaluate(() => window.roomSourceProbe.expiries[0]!());
	await expect.poll(() =>
		page.evaluate(() => window.roomSourceProbe.snapshot().destination!.source.messageId)
	).toBe("m2");
	await page.clock.runFor(200);
	expect(await page.evaluate(() => window.roomSourceProbe.snapshot().destination!.source.messageId))
		.toBe("m2");
	await page.clock.runFor(2799);
	expect(await page.evaluate(() => window.roomSourceProbe.snapshot().destination!.source.messageId))
		.toBe("m2");
	await page.clock.runFor(1);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().destination)).toBe(
		undefined,
	);
	await expect(page.locator("[data-source-exact]")).toHaveCount(0);
	expect(errors).toEqual([]);
});
test("same actualRoom instance resets source on room prop replacement", async ({ page }) => {
	let errors = await load(page);
	await select(page, "m1");
	await page.evaluate(() => window.roomSourceProbe.changeRoom("room-b"));
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().room)).toBe(
		"room-b",
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().destination)).toBe(
		undefined,
	);
	await expect(page.locator("[data-source-exact]")).toHaveCount(0);
	await page.clock.runFor(3100);
	expect(errors).toEqual([]);
});
test("unmount cleans actualTranscript owner and pending source expiry", async ({ page }) => {
	let errors = await load(page);
	await select(page, "m1");
	expect(await page.evaluate(() => window.roomSourceProbe.expiryHandles.length)).toBe(1);
	let expiryHandle = await page.evaluate(() => window.roomSourceProbe.expiryHandles[0]!);
	expect(expiryHandle).toEqual(expect.any(Number));
	expect(await page.evaluate(() => window.roomSourceProbe.clearedExpiryHandles))
		.not.toContain(expiryHandle);
	await page.evaluate(() => window.roomSourceProbe.unmount());
	expect(await page.evaluate(() => window.roomSourceProbe.clearedExpiryHandles))
		.toContain(expiryHandle);
	await page.clock.runFor(3100);
	await expect(page.locator("[data-chat-message-id]")).toHaveCount(0);
	expect(
		await page.evaluate(() => Array.from(CSS.highlights.get("conversation-source") ?? []).length),
	).toBe(0);
	expect(errors).toEqual([]);
});

test("a conversation-linked card-only document stays in Document", async ({ page }) => {
	let errors = await load(page);
	await page.evaluate(() =>
		window.roomSourceProbe.setQuestions({
			hasPlanContent: false,
			entries: [{
				id: "conversation-card",
				value: {
					id: "conversation-card",
					thread: "conversation-thread",
					questions: [{
						id: "conversation-question",
						header: "Rollout",
						prompt: "Which rollout?",
						multiple: false,
						options: [],
					}],
				},
			}],
		})
	);
	let control = page.getByRole("group", { name: "Document view", exact: true });
	await expect(control.getByRole("button", { name: "Document", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(control.getByRole("button", { name: "Decisions, 1 unanswered", exact: true }))
		.toHaveAttribute("aria-pressed", "false");
	expect(errors).toEqual([]);
});

test("a Planner-only card opening still moves to Decisions", async ({ page }) => {
	let errors = await load(page);
	await page.evaluate(() =>
		window.roomSourceProbe.setQuestions({
			hasPlanContent: false,
			entries: [{
				id: "planner-card",
				value: {
					id: "planner-card",
					questions: [{
						id: "planner-question",
						header: "Rollout",
						prompt: "Which rollout?",
						multiple: false,
						options: [],
					}],
				},
			}],
		})
	);
	let control = page.getByRole("group", { name: "Document view", exact: true });
	await expect(control.getByRole("button", { name: "Decisions, 1 unanswered", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	expect(errors).toEqual([]);
});

test("opening Decisions focuses reopened work ahead of settled history and later open cards", async ({ page }) => {
	let errors = await load(page);
	await page.evaluate(meta => {
		let entries = ["settled", "reopened", "later"].map(id => ({
			id,
			value: {
				id,
				questions: [{
					id: `${id}-question`,
					header: id,
					prompt: `Choose ${id}`,
					multiple: false,
					options: [],
					...(id === "reopened" ? { answer: "Old answer" } : {}),
				}],
			},
		}));
		window.roomSourceProbe.setQuestions({ hasPlanContent: true, entries });
		window.roomSourceProbe.receive({
			kind: "question:meta",
			id: "settled",
			meta: { ...meta, status: "discarded" },
			ts: 1,
		});
		window.roomSourceProbe.receive({
			kind: "question:meta",
			id: "reopened",
			meta: { ...meta, status: "reopened" },
			ts: 2,
		});
	}, meta);
	await page.getByRole("group", { name: "Document view", exact: true }).getByRole("button", {
		name: "Decisions, 2 unanswered",
		exact: true,
	}).click();
	await expect(page.locator('[data-plan-sidecar-questionnaire="reopened"]')).toBeFocused();
	await expect(page.locator('[data-plan-sidecar-questionnaire="settled"]')).toHaveCount(0);
	expect(errors).toEqual([]);
});
