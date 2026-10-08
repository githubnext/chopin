import { authenticate, content, expect, roomPath, test } from "./room";
import { openJevWire, sendChat, wireFrames, wireRequest, wireState } from "./jev-wire";

import type { Page } from "@playwright/test";

const QUESTION = "Should we ship a small pilot?";
const OPTION = "Start with a small pilot.";
const FIGMA_REPLY = "Sounds good to me. What about agent access? Copilot? BYO API keys?";
const THREE_CONTRIBUTIONS =
	"Sounds good to me. I am concerned that a small pilot will exclude keyboard-only users. What about agent access?";

async function waitForEvent(page: Page, type: string, count = 1) {
	await expect.poll(async () =>
		(await wireState(page))?.events.filter(event => event.type === type).length
	).toBe(count);
	return (await wireState(page))!;
}

async function eventsForMessage(page: Page, messageId: string) {
	await expect.poll(async () =>
		(await wireState(page))?.analysis.find(analysis => analysis.messageId === messageId)?.status
	).toBe("applied");
	let state = (await wireState(page))!;
	let analysis = state.analysis.find(item => item.messageId === messageId)!;
	return state.events.filter(event => analysis.eventIds.includes(event.id));
}

function card(page: Page) {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: QUESTION }) });
}

function prompt(page: Page) {
	return page.getByRole("group", { name: `Decision prompt: ${QUESTION}` });
}

async function expectRetiredPrompts(page: Page, summary: string) {
	let prompts = page.locator("[data-decision-prompt]");
	await expect(prompts.first()).toBeVisible();
	await expect.poll(async () => {
		let summaries = await prompts.allTextContents();
		return summaries.length > 0 && summaries.every(text => text.includes(summary));
	}).toBe(true);
	await expect(prompts.getByRole("button", { name: "Save decision", exact: true })).toHaveCount(0);
}

function scopedPrompt(page: Page) {
	return page.getByRole("group", { name: "Scoped choice: Lexical for this spike" });
}

function cardById(page: Page, id: string) {
	return page.locator(
		`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${id}"]`,
	);
}

async function scopedChoiceReady(ana: Page, bo: Page, room: string) {
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Which editor should we use?");
	await waitForEvent(ana, "thread.opened");
	await waitForEvent(ana, "card.linked");
	await sendChat(bo, "Lexical");
	await waitForEvent(ana, "option.added");
	await sendChat(bo, "Monaco");
	await waitForEvent(ana, "option.added", 2);
	await expect.poll(async () =>
		(await wireState(ana))?.threads[0]?.contributions.filter(
			item => item.kind === "option",
		).length
	).toBe(2);
	return (await wireState(ana))!.threads[0]!.questionnaireId!;
}

async function settled(ana: Page, bo: Page, room: string) {
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, QUESTION);
	await waitForEvent(ana, "thread.opened");
	await sendChat(bo, OPTION);
	await waitForEvent(ana, "option.added");
	await sendChat(bo, "Let's just go with a small pilot.");
	await waitForEvent(ana, "settle.suggested");
}

test("one member's choice posts a live Save decision prompt for everyone", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	let suggested = await waitForEvent(ana, "settle.suggested");
	expect(suggested.events.some(event => event.type === "decision.recorded")).toBe(false);
	await expect(prompt(ana)).toBeVisible();
	await expect(prompt(bo)).toBeVisible();
	await expect(prompt(ana)).toContainText(`Suggested: ${OPTION}`);
	await expect(prompt(ana).locator("img")).toHaveCount(0);

	await prompt(ana).getByRole("button", { name: "Save decision" }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		origin: "human",
		actor: { kind: "member", handle: "ana" },
	});
	for (let page of [ana, bo]) {
		await expectRetiredPrompts(page, `Decided: ${OPTION} · ana`);
	}
});

test("one person's scoped choice saves through the authenticated wire and survives reload", async ({ baseURL, browser, join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let cardId = await scopedChoiceReady(ana, bo, room);
	let messageId = await sendChat(ana, "I'd pick Lexical for the spike;");
	await waitForEvent(ana, "scoped-choice.proposed");
	let messageEvents = await eventsForMessage(ana, messageId);
	let proposal = messageEvents.find(event => event.type === "scoped-choice.proposed");
	if (proposal?.type !== "scoped-choice.proposed") throw new Error("scoped proposal is missing");
	expect(proposal).toMatchObject({
		type: "scoped-choice.proposed",
		cardId,
		label: "Lexical",
		scope: "spike",
		source: { messageId, author: { kind: "member", handle: "ana" } },
	});
	expect(
		messageEvents.some(event =>
			event.type === "option.added" || event.type === "settle.suggested"
			|| event.type === "decision.recorded"
		),
	).toBe(false);
	let proposalId = proposal.id;
	let notice = scopedPrompt(ana);
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("Save Lexical for this spike?");
	await expect(notice).toContainText("Ana");
	await expect(notice).toContainText("I'd pick Lexical for the spike;");
	await expect(notice.getByRole("button", { name: "Save for this spike" })).toBeEnabled();
	await expect(cardById(ana, cardId)).toBeVisible();
	let pending = (await wireState(ana))!.threads[0]!;
	expect(pending.status).toBe("exploring");
	expect(pending.decision).toBeUndefined();
	expect(pending.pendingScopedChoice).toMatchObject({ proposalId, optionId: proposal.optionId });

	let readerContext = await browser.newContext({ baseURL });
	try {
		let reader = await readerContext.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await openJevWire(reader, room);
		await expect(scopedPrompt(reader)).toBeVisible();
		await expect(
			scopedPrompt(reader).getByRole("button", {
				name: "Save for this spike",
			}),
		).toBeDisabled();
		let denied = await wireRequest(reader, {
			kind: "conversation-plan:scoped-choice-save",
			actionId: crypto.randomUUID(),
			threadId: pending.id,
			expectedVersion: pending.version,
			proposalId,
			cardId,
			optionId: proposal.optionId,
			expectedLabel: "Lexical",
			expectedGeneration: 0,
		});
		expect(denied.kind).toBe("session:error");
		expect(denied.message).toMatch(/write access/);
	} finally {
		await readerContext.close();
	}

	await notice.getByRole("button", { name: "Save for this spike" }).click();
	await expect.poll(async () =>
		(await wireState(ana))?.events.some(event =>
			event.type === "scoped-choice.saved" && event.proposalId === proposalId
		)
	).toBe(true);
	let saved = (await wireState(ana))!;
	expect(saved.events.some(event => event.type === "decision.recorded")).toBe(false);
	expect(saved.threads[0]?.status).toBe("exploring");
	await expect(cardById(ana, cardId)).toBeVisible();

	await ana.reload();
	await expect(content(ana)).toHaveAttribute("contenteditable", "true");
	await openJevWire(ana, room);
	await expect(scopedPrompt(ana)).toBeVisible();
	await expect(scopedPrompt(ana)).toContainText("Saved for this spike");
	await expect(
		scopedPrompt(ana).getByRole("button", {
			name: "Saved for this spike",
		}),
	).toBeDisabled();
	await expect(cardById(ana, cardId)).toBeVisible();
	let restored = (await wireState(ana))!;
	expect(restored.events.some(event => event.type === "decision.recorded")).toBe(false);
	expect(restored.threads[0]?.status).toBe("exploring");
	await expect.poll(async () => {
		let frame = (await wireFrames(ana)).findLast(item => item.kind === "question:metas") as
			| { cards?: Array<{ id: string; meta: { status: string; history: unknown[] } }> }
			| undefined;
		return frame?.cards?.find(item => item.id === cardId)?.meta;
	}).toMatchObject({ status: "open", history: [] });
});

test("a second member refreshes the scoped choice notice with both exact sources", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await scopedChoiceReady(ana, bo, room);
	await sendChat(ana, "I'd pick Lexical for the spike;");
	let proposed = await waitForEvent(ana, "scoped-choice.proposed");
	let proposal = proposed.events.find(event => event.type === "scoped-choice.proposed");
	if (proposal?.type !== "scoped-choice.proposed") throw new Error("scoped proposal is missing");
	await expect(scopedPrompt(ana)).toBeVisible();

	let agreementMessage = await sendChat(
		bo,
		"yep, Lexical for the spike. not a final library call yet.",
	);
	await waitForEvent(ana, "scoped-choice.agreed");
	let agreementEvents = await eventsForMessage(ana, agreementMessage);
	let agreement = agreementEvents.find(event => event.type === "scoped-choice.agreed");
	if (agreement?.type !== "scoped-choice.agreed") throw new Error("scoped agreement is missing");
	expect(agreement).toMatchObject({
		type: "scoped-choice.agreed",
		proposalId: proposal.id,
		cardId: proposal.cardId,
		optionId: proposal.optionId,
		label: "Lexical",
		scope: "spike",
		source: { messageId: agreementMessage, author: { kind: "member", handle: "bo" } },
	});
	expect(
		agreementEvents.some(event =>
			event.type === "settle.agreed" || event.type === "decision.recorded"
		),
	).toBe(false);
	await expect(scopedPrompt(ana)).toHaveCount(1);
	let refreshed = scopedPrompt(ana);
	await expect(refreshed).toContainText("Ana");
	await expect(refreshed).toContainText("I'd pick Lexical for the spike;");
	await expect(refreshed).toContainText("Bo");
	await expect(refreshed).toContainText("yep, Lexical for the spike.");
	await expect(refreshed.getByRole("button", { name: "Save for this spike" })).toBeEnabled();
	let noticeFrame = (await wireFrames(ana)).find(frame =>
		frame.kind === "chat:message" && JSON.stringify(frame).includes(agreement.id)
	);
	expect(noticeFrame).toMatchObject({
		entry: {
			decision: {
				proposalId: proposal.id,
				triggerEventId: agreement.id,
				sources: [
					{
						messageId: proposal.source.messageId,
						author: { kind: "member", handle: "ana" },
						quote: "I'd pick Lexical for the spike;",
						start: 0,
						end: 31,
						role: "support",
					},
					{
						messageId: agreementMessage,
						author: { kind: "member", handle: "bo" },
						quote: "yep, Lexical for the spike.",
						start: 0,
						end: 27,
						role: "support",
					},
				],
			},
		},
	});
	let sources = (noticeFrame as unknown as {
		entry: { decision: { sources: Array<{ quote: string; start: number; end: number }> } };
	})
		.entry.decision.sources;
	let sourceTexts = [
		"I'd pick Lexical for the spike;",
		"yep, Lexical for the spike. not a final library call yet.",
	];
	for (let [index, source] of sources.entries()) {
		expect(sourceTexts[index]!.slice(source.start, source.end)).toBe(source.quote);
	}
});

test("the Figma mixed reply settles the pending option and opens its sourced question", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);

	let messageId = await sendChat(ana, FIGMA_REPLY);
	let events = await eventsForMessage(ana, messageId);
	expect(events.map(event => event.type)).toEqual([
		"stance.changed",
		"settle.agreed",
		"thread.opened",
	]);
	expect(events.map(event => "source" in event ? event.source?.quote : undefined)).toEqual([
		"Sounds good to me.",
		"Sounds good to me.",
		"What about agent access?",
	]);
	expect(events.some(event => event.type === "decision.recorded")).toBe(false);
	await expect(prompt(ana)).toBeVisible();

	await prompt(ana).getByRole("button", { name: "Save decision" }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		origin: "human",
		actor: { kind: "member", handle: "ana" },
	});
});

test("one mixed reply keeps agreement, concern, and question sources separate", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);

	let messageId = await sendChat(ana, THREE_CONTRIBUTIONS);
	let events = await eventsForMessage(ana, messageId);
	expect(events.map(event => event.type)).toEqual([
		"stance.changed",
		"settle.agreed",
		"stance.changed",
		"thread.opened",
	]);
	expect(events.map(event => "source" in event ? event.source?.quote : undefined)).toEqual([
		"Sounds good to me.",
		"Sounds good to me.",
		"I am concerned that a small pilot will exclude keyboard-only users.",
		"What about agent access?",
	]);
	expect(events.some(event => event.type === "decision.recorded")).toBe(false);
	await expect(prompt(ana)).toBeVisible();
});

test("a late retraction beyond the ownership context limit has no classifier effect", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	let message = `${"Sounds good to me. ".padEnd(4001, "x")}Actually, no.`;

	let messageId = await sendChat(ana, message);
	await expect.poll(async () =>
		(await wireState(ana))?.analysis.find(analysis => analysis.messageId === messageId)?.status
	).toBe("unlinked");
	let state = (await wireState(ana))!;
	let analysis = state.analysis.find(item => item.messageId === messageId)!;
	expect(analysis).toMatchObject({ policyGate: "message exceeds ownership context", passes: [] });
	expect(analysis.eventIds).toEqual([]);
	await expect(prompt(ana)).toHaveCount(1);
});

test("repeated agreement does not duplicate a live prompt", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	await sendChat(ana, "Sounds good to me.");
	await waitForEvent(ana, "settle.agreed");
	await expect(prompt(ana)).toBeVisible();

	let repeated = await sendChat(ana, "Sounds good to me.");
	await expect.poll(async () =>
		(await wireState(ana))?.analysis.find(item => item.messageId === repeated)?.status
	).toBe("applied");
	await expect.poll(async () => {
		let state = await wireState(ana);
		let analysis = state?.analysis.find(item => item.messageId === repeated);
		return analysis?.eventIds.some(id =>
			state?.events.some(event => event.id === id && event.type === "settle.agreed")
		) ?? false;
	}).toBe(true);
	let repeatedState = (await wireState(ana))!;
	expect(repeatedState.events.filter(event => event.type === "settle.agreed")).toHaveLength(2);
	await expect(prompt(ana)).toHaveCount(1);
	await expect(
		ana.locator("[data-decision-prompt]").getByRole("button", {
			name: "Save decision",
			exact: true,
		}),
	).toHaveCount(1);
	await expect(prompt(ana)).toBeVisible();
});

test("a remote human card selection overrides the live prompt", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	await sendChat(ana, "Sounds good to me.");
	await waitForEvent(ana, "settle.agreed");
	await expect(prompt(ana)).toBeVisible();
	let decision = card(bo);
	await decision.getByRole("button", { name: "Add an option", exact: true }).click();
	await decision.getByRole("textbox", { name: "New option" }).fill("Ship to everyone");
	await bo.keyboard.press("Enter");
	await decision.getByText("Ship to everyone", { exact: true }).click();
	await expect(decision.getByRole("radio", { name: "Ship to everyone" })).toBeChecked();

	await expect(prompt(ana)).toContainText("Selected: Ship to everyone");
	await expect(prompt(ana)).not.toContainText(`Suggested: ${OPTION}`);
	await expect.poll(async () =>
		(await wireState(ana))?.threads[0]?.contributions.find(item =>
			item.kind === "option" && item.text === "Ship to everyone"
		)?.id
	).toEqual(expect.any(String));
	let selectedOption =
		(await wireState(ana))!.threads[0]!.contributions.find(item =>
			item.kind === "option" && item.text === "Ship to everyone"
		)!.id;
	await prompt(ana).getByRole("button", { name: "Save decision" }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		actor: { kind: "member", handle: "ana" },
		optionId: selectedOption,
		origin: "human",
	});
	for (let page of [ana, bo]) {
		await expectRetiredPrompts(page, "Decided: Ship to everyone · ana");
	}
});

test("Open in plan focuses the card and Discard collapses the prompt", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	await sendChat(ana, "Sounds good to me.");
	await waitForEvent(ana, "settle.agreed");
	await prompt(ana).getByRole("button", { name: "Open in plan" }).click();
	let decision = card(ana);
	await expect(decision).toBeFocused();
	await decision.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(decision.getByText("Discard this decision?", { exact: true })).toBeVisible();
	await decision.getByRole("button", { name: "Discard", exact: true }).click();
	await expectRetiredPrompts(ana, "Discarded");
});

test("the proposer's own assent does not post another prompt", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	let assent = await sendChat(bo, "Sounds good to me.");
	await expect.poll(async () =>
		(await wireState(ana))?.analysis.find(item => item.messageId === assent)?.status
	).toBe("applied");
	let state = (await wireState(ana))!;
	let analysis = state.analysis.find(item => item.messageId === assent)!;
	expect(
		analysis.eventIds.some(id =>
			state.events.some(event => event.id === id && event.type === "settle.agreed")
		),
	).toBe(false);
	await expect(ana.locator("[data-decision-prompt]")).toHaveCount(1);
});

test("an old prompt retires after Save and Reopen before a new suggestion", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	await sendChat(ana, "Sounds good to me.");
	await waitForEvent(ana, "settle.agreed");
	await prompt(ana).getByRole("button", { name: "Save decision" }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	let cardId = decided.threads[0]!.questionnaireId!;
	await expectRetiredPrompts(ana, `Decided: ${OPTION} · ana`);
	let retiredCount = await ana.locator("[data-decision-prompt]").count();

	await ana.getByRole("button", { name: /^Decisions/ }).click();
	await ana.getByRole("button", { name: "1 resolved" }).click();
	let resolved = ana.locator(
		`[data-document-view="decisions"] article[data-plan-sidecar-questionnaire="${cardId}"]`,
	);
	await resolved.getByRole("button", { name: "Reopen" }).click();
	await waitForEvent(ana, "decision.reopened");
	await expectRetiredPrompts(ana, "Reopened");

	await sendChat(bo, "Let's just go with a small pilot.");
	await waitForEvent(ana, "settle.suggested", 2);
	let prompts = ana.locator("[data-decision-prompt]");
	let retired = prompts.filter({ hasText: "Reopened" });
	await expect(prompts).toHaveCount(retiredCount + 1);
	await expect(retired).toHaveCount(retiredCount);
	await expect(retired.getByRole("button", { name: "Save decision" })).toHaveCount(0);
	await expect(prompt(ana)).toHaveCount(1);
	await expect(prompt(ana)).toBeVisible();
	await ana.reload();
	await expect(prompts).toHaveCount(retiredCount + 1);
	await expect(retired).toHaveCount(retiredCount);
	await expect(retired.getByRole("button", { name: "Save decision" })).toHaveCount(0);
	await expect(prompt(ana)).toHaveCount(1);
	await expect(prompt(ana)).toBeVisible();
});

test("a read-only prompt keeps Save disabled while Open in plan stays available", async ({ baseURL, browser, join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await settled(ana, bo, room);
	await sendChat(ana, "Sounds good to me.");
	await waitForEvent(ana, "settle.agreed");
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await expect(prompt(reader)).toBeVisible();
		await expect(prompt(reader).getByRole("button", { name: "Save decision" })).toHaveCount(0);
		await prompt(reader).getByRole("button", { name: "Open in plan" }).click();
		await expect(card(reader)).toBeFocused();
	} finally {
		await context.close();
	}
});
