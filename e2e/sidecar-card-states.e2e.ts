/** Browser coverage for decision card lifecycle states and metadata regrouping. */

import { authenticate, content, expect, roomPath, test } from "./room";

import type { Question } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PROSE = "Room state lives on disk as MDX beside the transcript.\n";
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SECOND_QUESTION = "01K0N4W3B7P27CBAEC7A8C8WEB";
const SECOND_OPTION = "01K0N4W3B7P27CBAEC7A8C8WEC";
const ANCHORED_DEFINITION = {
	questions: [{
		id: QUESTION,
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ id: OPTION, label: "Canary", description: "" }],
	}],
};
const ANCHORED_DIGEST = "sha256:3ccc3e648811df8180799f8b012c6934bcf44a306f5eb8b8c9d2676b0493ccf4";

const DECIDED_CARD = `<Questionnaire id="${WIDGET}" by="ana" status="decided">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
<Answer value="Canary" choices="${OPTION}" />
</Question>
</Questionnaire>`;
const DECIDED_RECORD = {
	id: WIDGET,
	definition: ANCHORED_DEFINITION,
	status: "answered",
	answers: { [QUESTION]: "Canary" },
	choices: [OPTION],
	resolver: "ana",
	owner: "ana",
	decidedAt: 1_790_000_000,
	history: [],
	optionOrigins: {},
	editors: [],
};
const MULTI_DECIDED_DEFINITION = {
	questions: [
		...ANCHORED_DEFINITION.questions,
		{
			id: SECOND_QUESTION,
			header: "Scope",
			question: "What belongs in the first cut?",
			multiple: false,
			options: [{ id: SECOND_OPTION, label: "Anchors", description: "" }],
		},
	],
};
const LEGACY_MULTI_DECIDED_CARD = `<Questionnaire id="${WIDGET}" by="ana" status="decided">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
<Answer value="Only collaborative anchors" />
</Question>
<Question id="${SECOND_QUESTION}" header="Scope" prompt="What belongs in the first cut?" multiple="false">
<Option id="${SECOND_OPTION}" label="Anchors" />
<Answer value="Anchors" choices="${SECOND_OPTION}" />
</Question>
</Questionnaire>`;

function questionnaire(page: Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

function cardByPrompt(page: Page, prompt: string) {
	return questionnaire(page).filter({ hasText: prompt });
}

test("discarding an open card moves it into a collapsed, persistent resolved history", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({
		hasText: "Where should room state live?",
	});
	let cardId = await card.getAttribute("data-plan-sidecar-questionnaire");
	if (!cardId) throw new Error("questionnaire id missing");
	await card.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(card.getByText("Discard this decision?", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Discard", exact: true }).click();

	await expect(
		page.locator(`[data-document-view="decisions"] [data-plan-sidecar-questionnaire="${cardId}"]`),
	)
		.toHaveCount(0);
	let discarded = page.getByRole("button", { name: "1 resolved" });
	await expect(discarded).toHaveAttribute("aria-expanded", "false");
	await discarded.click();
	await expect(cardByPrompt(page, "Where should room state live?"))
		.toContainText("Discarded by @ana");

	await page.reload();
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.getByRole("button", { name: "1 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
});

test("discarding a decided card records the person who discarded it", async ({ join, seed }) => {
	await seed(PROSE);
	let ana = await join("ana");
	let ben = await join("ben");
	for (let page of [ana, ben]) await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = (page: Page) =>
		questionnaire(page).filter({
			hasText: "Where should room state live?",
		});

	await card(ana).getByText("In SQLite", { exact: true }).click();
	await card(ana).getByRole("button", { name: "Save", exact: true }).click();
	await expect(ben.getByRole("button", { name: "1 resolved" })).toBeVisible();
	await ben.getByRole("button", { name: "1 resolved" }).click();
	await card(ben).getByRole("button", { name: "Discard", exact: true }).click();
	await card(ben).getByRole("button", { name: "Discard decision" }).click();

	await expect(ben.getByRole("button", { name: "1 resolved" }))
		.toHaveAttribute("aria-expanded", "true");
	let discardedCard = cardByPrompt(ben, "Where should room state live?");
	await expect(discardedCard).toContainText("Discarded by @ben");
	await expect(discardedCard).not.toContainText("Discarded by @ana");
	await ben.reload();
	await ben.getByRole("button", { name: /^Decisions/ }).click();
	await expect(ben.getByRole("button", { name: "1 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(cardByPrompt(ben, "Where should room state live?"))
		.toContainText("Discarded by @ben");
});

test("reopening a decision shares a fresh draft and a later Save survives reload", async ({ join, seed }) => {
	await seed(PROSE);
	let ana = await join("ana");
	let ben = await join("ben");
	for (let page of [ana, ben]) await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = (page: Page) =>
		questionnaire(page).filter({
			hasText: "Where should room state live?",
		});

	await card(ana).getByText("In SQLite", { exact: true }).click();
	await card(ana).getByRole("button", { name: "Save", exact: true }).click();
	await ana.getByRole("button", { name: "1 resolved" }).click();
	await card(ana).getByRole("button", { name: "Reopen" }).click();

	for (let page of [ana, ben]) {
		await expect(card(page).getByText("Previously: In SQLite · @ana")).toBeVisible();
		await expect(card(page).getByRole("radio", { name: "In SQLite" })).not.toBeChecked();
	}
	await card(ben).getByText("On disk as MDX", { exact: true }).click();
	await expect(card(ana).getByRole("radio", { name: "On disk as MDX" })).toBeChecked();
	await card(ben).getByRole("button", { name: "Save", exact: true }).click();
	await expect(ana.getByRole("button", { name: "1 resolved" })).toBeVisible();
	await ana.reload();
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	await expect(ana.getByRole("button", { name: "1 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(cardByPrompt(ana, "Where should room state live?"))
		.toContainText("On disk as MDX");
});

test("card metadata regroups Decisions before the document update arrives", async ({ join, page, seed }) => {
	await seed(PROSE);
	let holdPlanUpdates = false;
	let heldUpdates: string[] = [];
	let didHoldUpdate!: () => void;
	let updateHeld = new Promise<void>(resolve => didHoldUpdate = resolve);
	let didDecide!: () => void;
	let decided = new Promise<void>(resolve => didDecide = resolve);
	let questionId: string | undefined;
	let serverSender: { send: (message: string) => void } | undefined;
	let releaseHeldUpdates = () => {
		if (!serverSender) throw new Error("WebSocket route is not ready");
		for (let update of heldUpdates) serverSender.send(update);
		heldUpdates = [];
	};

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		serverSender = { send: message => route.send(message) };
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				id?: string;
				meta?: { status?: string };
			};
			if (holdPlanUpdates && frame.kind === "plan:update") {
				heldUpdates.push(message);
				didHoldUpdate();
				return;
			}
			if (
				frame.id === questionId && frame.kind === "question:meta"
				&& frame.meta?.status === "decided"
			) didDecide();
			route.send(message);
		});
	});

	let ben = await join("ben");
	let ana = await join("ana");
	for (let page of [ana, ben]) await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(ben.getByRole("button", { name: "Decisions, 2 unanswered" })).toBeVisible();
	let benCard = questionnaire(ben).filter({
		has: ben.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await benCard.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	if (!questionId) throw new Error("questionnaire id missing");
	let benChoice = benCard.getByRole("radio", { name: "On disk as MDX" });
	await benChoice.focus();
	await expect(benChoice).toBeFocused();
	holdPlanUpdates = true;
	let anaCard = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	await anaCard.getByText("On disk as MDX", { exact: true }).click();
	await anaCard.getByRole("button", { name: "Save", exact: true }).click();
	await Promise.all([updateHeld, decided]);

	await expect(ben.getByRole("button", { name: "Decisions, 1 unanswered" })).toBeVisible();
	await expect(
		questionnaire(ben).filter({
			has: ben.getByRole("heading", { name: "Which of these belong in the first cut?" }),
		}),
	).toBeFocused();
	await ben.getByRole("button", { name: "1 resolved" }).click();
	let decidedCard = cardByPrompt(ben, "Where should room state live?");
	await expect(decidedCard).toBeVisible();
	await expect(decidedCard.getByRole("button", { name: "Reopen" })).toBeVisible();
	await expect(decidedCard.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	expect(heldUpdates.length).toBeGreaterThan(0);
	releaseHeldUpdates();
});

test("resolved cards show no actions to a read-only viewer", async ({ baseURL, browser, join, room, seed }) => {
	await seed(`${PROSE}\n${DECIDED_CARD}`, { questions: [DECIDED_RECORD] });
	await join("ana");
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await reader.getByRole("button", { name: /^Decisions/ }).click();
		await reader.getByRole("button", { name: "1 resolved" }).click();
		let card = reader.locator(
			`[data-document-view="decisions"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
		);
		await expect(card).toContainText("Answered by @ana");
		await expect(card.getByRole("button", { name: "Reopen" })).toHaveCount(0);
		await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("a legacy multi card reopens with its text-only previous answer", async ({ join, seed }) => {
	let record = {
		...DECIDED_RECORD,
		definition: MULTI_DECIDED_DEFINITION,
		answers: {
			[QUESTION]: "Only collaborative anchors",
			[SECOND_QUESTION]: "Anchors",
		},
		choices: [SECOND_OPTION],
	};
	await seed(`${PROSE}\n${LEGACY_MULTI_DECIDED_CARD}`, { questions: [record] });
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "1 resolved" }).click();
	let card = page.locator(
		`[data-document-view="decisions"] [data-plan-sidecar-questionnaire="${WIDGET}"]`,
	);
	await card.getByRole("button", { name: "Reopen" }).click();
	await expect(card).toContainText("Previously: Only collaborative anchors · @ana");
	await expect(card.getByRole("radio", { name: "Canary" })).not.toBeChecked();
	await card.getByRole("button", { name: "Next question", exact: true }).click();
	await expect(card.getByRole("heading", { name: "What belongs in the first cut?" }))
		.toBeVisible();
	await expect(card).toContainText("Previously: Anchors · @ana");
	await expect(card.getByRole("radio", { name: "Anchors" })).not.toBeChecked();
});

test("an orphaned prose anchor retains its authoritative state and resolved card", async ({ join, page, seed }) => {
	await seed(`${PROSE}\n${DECIDED_CARD}`, {
		questions: [{
			...DECIDED_RECORD,
			prose: [{ epoch: "old", position: "AAAA", digest: ANCHORED_DIGEST, orphaned: true }],
		}],
	});
	let orphaned: boolean | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as {
					kind: string;
					id?: string;
					meta?: Question.CardMeta;
					cards?: Question.Metas["cards"];
				};
				if (frame.kind === "question:metas") {
					orphaned = frame.cards?.find(card => card.id === WIDGET)?.meta.proseOrphaned;
				}
				if (frame.kind === "question:meta" && frame.id === WIDGET) {
					orphaned = frame.meta?.proseOrphaned;
				}
			}
			route.send(message);
		});
	});
	await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "1 resolved" }).click();
	await expect.poll(() => orphaned).toBe(true);
	await expect(cardByPrompt(page, "How should we deploy?"))
		.toContainText("Canary");
});

test("conversation decisions settle inline while their prose is being written up", async ({ join, seed }) => {
	await seed(`${PROSE}\n${DECIDED_CARD}`, {
		questions: [{ ...DECIDED_RECORD, origin: "conversation" }],
	});
	let page = await join("ana");
	let settled = content(page).locator("[data-card-settled]");
	await expect(settled).toContainText("Decided: Canary · @ana");
	await expect(settled).toContainText("writing up…");
});
