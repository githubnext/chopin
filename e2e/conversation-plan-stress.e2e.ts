import { SQL } from "bun";

import { openJevWire, sendChat, wireState } from "./jev-wire";
import { authenticate, expect, roomPath, test } from "./room";

import type { ConversationPlan } from "../packages/protocol/index";
import type { Browser, Page } from "@playwright/test";

const PILOT_QUESTION = "Should we ship a small pilot?";
const FILES_QUESTION = "Should we store uploaded files in Amazon S3 or on a local disk?";
const EMAIL_QUESTION = "Which service should send notification emails?";
const AGENT_ACCESS_QUESTION = "Should our team use an AI coding agent?";
const ACCESS_QUESTION = "What about agent access?";
const PILOT_OPTION = "Start with a small pilot.";
const BROAD_OPTION = "Ship to everyone";
const EMAIL_RECOMMENDATION = "We should use Postmark for notification emails.";
const HELD_AGENT_ACCESS =
	"Copilot or bring-your-own API keys would simplify agent access for our team.";

function card(page: Page, question: string) {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({ has: page.getByRole("heading", { name: question, exact: true }) });
}

function prompt(page: Page, question = PILOT_QUESTION) {
	return page.getByRole("group", { name: `Decision prompt: ${question}` });
}

async function stateWith(page: Page, type: ConversationPlan.Event["type"], count = 1) {
	await expect.poll(async () =>
		(await wireState(page))?.events.filter(event => event.type === type).length
	).toBe(count);
	return (await wireState(page))!;
}

async function readonlyReader(browser: Browser, baseURL: string, room: string) {
	let context = await browser.newContext({ baseURL });
	try {
		let page = await context.newPage();
		await authenticate(page, "readonly", baseURL);
		await page.goto(roomPath(room));
		await expect(page.getByRole("textbox", { name: "editable markdown" }))
			.toHaveAttribute("contenteditable", "false");
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function addOption(page: Page, question: string, option: string) {
	let target = card(page, question);
	await target.getByRole("button", { name: "Add another option" }).click();
	await target.getByRole("textbox", { name: "New option" }).fill(option);
	await page.keyboard.press("Enter");
	await expect(target.getByRole("radio", { name: option, exact: true })).toBeVisible();
}

async function persistedConversation(port: number, room: string) {
	let database = new SQL(
		process.env.E2E_DATABASE_URL_0
			?? `postgresql://chopin:chopin@127.0.0.1:${
				port === 8789 ? 5434 : 5433
			}/chopin?sslmode=disable`,
	);
	try {
		let [row] = await database<{
			sidecar: string | { conversationPlan?: ConversationPlan.State };
		}[]>`
			SELECT sidecar FROM channel_state WHERE channel_id = ${room}
		`;
		let sidecar = typeof row?.sidecar === "string"
			? JSON.parse(row.sidecar) as { conversationPlan?: ConversationPlan.State }
			: row?.sidecar;
		return sidecar?.conversationPlan;
	} finally {
		await database.close();
	}
}

test("three members carry two sourced questions through a suggested and a human choice", async ({ join, room, baseURL }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let cam = await join("cam");
	for (let page of [ana, bo, cam]) await openJevWire(page, room);

	let questionId = await sendChat(ana, PILOT_QUESTION);
	await stateWith(cam, "card.linked");
	let optionId = await sendChat(bo, PILOT_OPTION);
	await stateWith(ana, "option.added");
	let reasonId = await sendChat(cam, "A small pilot would catch setup problems early.");
	await stateWith(bo, "reason.added");
	let constraintId = await sendChat(ana, "Keep the pilot accessible to keyboard-only users.");
	await stateWith(cam, "constraint.added");
	let first = (await wireState(ana))!.threads[0]!;
	expect(first.questionSources[0]?.messageId).toBe(questionId);
	expect(first.contributions.find(item => item.kind === "option")?.sources[0]?.messageId)
		.toBe(optionId);
	expect(first.contributions.find(item => item.kind === "reason")?.sources[0]?.messageId)
		.toBe(reasonId);
	expect(first.contributions.find(item => item.kind === "constraint")?.sources[0]?.messageId)
		.toBe(constraintId);

	// Keep several ordinary chat turns in flight between the question and suggestion.
	let fillerIds: string[] = [];
	for (let page of [bo, cam, ana, bo, cam, ana]) {
		fillerIds.push(await sendChat(page, "Maybe that?"));
	}
	await addOption(cam, PILOT_QUESTION, BROAD_OPTION);
	await expect.poll(async () => {
		let state = await wireState(ana);
		return fillerIds.every(id =>
			state?.analysis.some(item => item.messageId === id && item.status === "unlinked")
		);
	}).toBe(true);

	let settleId = await sendChat(bo, "Let's just go with a small pilot.");
	let suggested = await stateWith(ana, "settle.suggested");
	let pilot = suggested.threads.find(thread => thread.id === first.id)!;
	let suggestedOption = pilot.contributions.find(item =>
		item.kind === "option" && item.id === pilot.pendingSettle?.optionId
	)!;
	expect(suggestedOption.text).toBe(PILOT_OPTION);
	let humanChoice = BROAD_OPTION;
	expect(suggested.events.find(event => event.type === "settle.suggested")?.source?.messageId)
		.toBe(settleId);

	let mixedId = await sendChat(
		ana,
		"Sounds good to me. What about agent access? Copilot? BYO API keys?",
	);
	let opened = await stateWith(cam, "thread.opened", 2);
	let access = opened.threads.find(thread => thread.question === ACCESS_QUESTION)!;
	expect(access.questionSources[0]).toMatchObject({
		messageId: mixedId,
		quote: ACCESS_QUESTION,
		author: { kind: "member", handle: "ana" },
	});
	for (let page of [ana, bo, cam]) {
		await expect(card(page, PILOT_QUESTION)).toBeVisible();
		await expect(card(page, ACCESS_QUESTION)).toBeVisible();
		await expect(prompt(page)).toContainText(`Suggested: ${suggestedOption.text}`);
	}
	await ana.screenshot({ path: "e2e/test-results/conversation-stress-before.png", fullPage: true });

	await card(cam, PILOT_QUESTION).getByText(humanChoice, { exact: true }).click();
	await expect(prompt(ana)).toContainText(`Selected: ${humanChoice}`);
	await prompt(ana).getByRole("button", { name: "Save decision" }).click();
	let decided = await stateWith(bo, "decision.recorded");
	let chosen = decided.threads.find(thread => thread.id === first.id)!.contributions
		.find(item => item.kind === "option" && item.text === humanChoice)!;
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		threadId: first.id,
		optionId: chosen.id,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
	});

	await addOption(bo, ACCESS_QUESTION, "Use Copilot for the first release");
	let accessCard = card(bo, ACCESS_QUESTION);
	await accessCard.getByText("Use Copilot for the first release", { exact: true }).click();
	await accessCard.getByRole("button", { name: "Save", exact: true }).click();
	let final = await stateWith(cam, "decision.recorded", 2);
	expect(final.threads.find(thread => thread.id === first.id)?.status).toBe("decided");
	expect(final.threads.find(thread => thread.id === access.id)?.status).toBe("decided");
	expect(final.events.filter(event => event.type === "decision.recorded")).toHaveLength(2);
	for (let page of [ana, bo, cam]) {
		await expect(page.locator("[data-decision-prompt]")).toContainText(
			`Decided: ${humanChoice} · ana`,
		);
	}
	await ana.screenshot({ path: "e2e/test-results/conversation-stress-after.png", fullPage: true });

	let port = Number(new URL(baseURL!).port);
	await expect.poll(async () => (await persistedConversation(port, room))?.revision)
		.toBe(final.revision);
	let persisted = (await persistedConversation(port, room))!;
	expect(persisted.threads.map(thread => [thread.id, thread.status]))
		.toEqual(final.threads.map(thread => [thread.id, thread.status]));
	expect(persisted.events.filter(event => event.type === "decision.recorded"))
		.toEqual(final.events.filter(event => event.type === "decision.recorded"));
	await bo.reload();
	await expect(bo.locator(`[data-chat-message-id="${mixedId}"]`)).toBeVisible();
	await expect(bo.locator("[data-decision-prompt]")).toContainText(
		`Decided: ${humanChoice} · ana`,
	);
});

test("a chat burst preserves a new question and a reason on the existing card", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let cam = await join("cam");
	for (let page of [ana, bo, cam]) await openJevWire(page, room);
	await sendChat(ana, PILOT_QUESTION);
	await stateWith(ana, "card.linked");
	await sendChat(bo, PILOT_OPTION);
	await stateWith(ana, "option.added");
	await sendChat(bo, "Let's just go with a small pilot.");
	await stateWith(ana, "settle.suggested");

	let [mixedId, reasonId] = await Promise.all([
		sendChat(ana, "Sounds good to me. What about agent access? Copilot? BYO API keys?"),
		sendChat(cam, "A small pilot would catch setup problems early."),
	]);
	await expect.poll(async () => {
		let state = await wireState(bo);
		return [mixedId, reasonId].every(id =>
			state?.analysis.some(item => item.messageId === id && item.status === "applied")
		);
	}).toBe(true);
	let state = (await wireState(bo))!;
	expect(state.threads.map(thread => thread.question))
		.toEqual([PILOT_QUESTION, ACCESS_QUESTION]);
	expect(state.events.filter(event => event.type === "thread.opened")).toHaveLength(2);
	expect(state.events.filter(event => event.type === "option.added")).toHaveLength(1);
	expect(
		state.threads[0]!.contributions.find(item =>
			item.kind === "reason" && item.sources.some(source => source.messageId === reasonId)
		),
	).toBeTruthy();
	expect(state.threads[1]!.questionSources[0]?.messageId).toBe(mixedId);
	for (let page of [ana, bo, cam]) {
		await expect(card(page, PILOT_QUESTION)).toHaveCount(1);
		await expect(card(page, ACCESS_QUESTION)).toHaveCount(1);
	}
});

test("a direct alternatives question keeps both sourced options and allows another card", async ({ join, room }) => {
	let ana = await join("ana");
	await openJevWire(ana, room);

	let alternativesId = await sendChat(ana, FILES_QUESTION);
	await stateWith(ana, "thread.opened");
	let withOptions = await stateWith(ana, "option.added", 2);
	await stateWith(ana, "card.linked");
	let files = withOptions.threads[0]!;
	expect(files.question).toBe(FILES_QUESTION);
	expect(files.questionSources[0]).toMatchObject({
		messageId: alternativesId,
		quote: FILES_QUESTION,
	});
	let options = files.contributions.filter(item => item.kind === "option");
	expect(options.map(item => item.text)).toEqual(["Amazon S3", "on a local disk"]);
	expect(options.map(item => item.sources[0])).toMatchObject([
		{ messageId: alternativesId, quote: "Amazon S3", role: "option" },
		{ messageId: alternativesId, quote: "on a local disk", role: "option" },
	]);
	expect(files.decision).toBeUndefined();
	expect(withOptions.events.some(event => event.type === "decision.recorded")).toBe(false);
	let filesCard = card(ana, FILES_QUESTION);
	await expect(filesCard).toHaveCount(1);
	await expect(filesCard.getByRole("radio", { name: "Amazon S3", exact: true })).toBeVisible();
	await expect(filesCard.getByRole("radio", { name: "on a local disk", exact: true }))
		.toBeVisible();

	await sendChat(ana, PILOT_QUESTION);
	let withSecondQuestion = await stateWith(ana, "thread.opened", 2);
	await stateWith(ana, "card.linked", 2);
	expect(withSecondQuestion.threads.map(thread => thread.question)).toEqual([
		FILES_QUESTION,
		PILOT_QUESTION,
	]);
	expect(withSecondQuestion.events.some(event => event.type === "decision.recorded")).toBe(false);
	await expect(filesCard).toHaveCount(1);
	await expect(card(ana, PILOT_QUESTION)).toHaveCount(1);
});

test("a direct recommendation adds and suggests a sourced choice until a member saves it", async ({ join, room, baseURL }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	for (let page of [ana, bo]) await openJevWire(page, room);

	await sendChat(ana, EMAIL_QUESTION);
	await stateWith(ana, "card.linked");
	let emailCard = card(ana, EMAIL_QUESTION);
	await expect(emailCard).toBeVisible();
	await expect(emailCard.getByRole("radio")).toHaveCount(0);

	let recommendationId = await sendChat(bo, EMAIL_RECOMMENDATION);
	let suggested = await stateWith(ana, "settle.suggested");
	await stateWith(ana, "option.added");
	let emailThread = suggested.threads.find(thread => thread.question === EMAIL_QUESTION)!;
	let option = emailThread.contributions.find(item =>
		item.kind === "option" && item.sources.some(source => source.messageId === recommendationId)
	)!;
	expect(option).toMatchObject({
		text: EMAIL_RECOMMENDATION,
		authoring: "quoted",
		sources: [{ messageId: recommendationId, quote: EMAIL_RECOMMENDATION, role: "option" }],
	});
	expect(emailThread.pendingSettle?.optionId).toBe(option.id);
	expect(emailThread.decision).toBeUndefined();
	expect(suggested.events.some(event => event.type === "decision.recorded")).toBe(false);
	let recommendedRadio = emailCard.getByRole("radio", {
		name: `${EMAIL_RECOMMENDATION} from chat`,
		exact: true,
	});
	await expect(recommendedRadio).toBeChecked();
	await expect(emailCard.getByText("from chat", { exact: true })).toBeVisible();
	await expect(prompt(ana, EMAIL_QUESTION)).toContainText(`Suggested: ${EMAIL_RECOMMENDATION}`);
	await expect(prompt(ana, EMAIL_QUESTION).getByRole("button", { name: "Save decision" }))
		.toBeVisible();
	await expect(prompt(bo, EMAIL_QUESTION)).toContainText(`Suggested: ${EMAIL_RECOMMENDATION}`);
	await expect(prompt(bo, EMAIL_QUESTION).getByRole("button", { name: "Save decision" }))
		.toBeVisible();

	await prompt(ana, EMAIL_QUESTION).getByRole("button", { name: "Save decision" }).click();
	let decided = await stateWith(bo, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		threadId: emailThread.id,
		optionId: option.id,
		origin: "human",
		actor: { kind: "member", handle: "ana" },
	});
	expect(decided.threads.find(thread => thread.id === emailThread.id)?.decision)
		.toMatchObject({ optionId: option.id, actor: { handle: "ana" } });

	let port = Number(new URL(baseURL!).port);
	await expect.poll(async () => (await persistedConversation(port, room))?.revision)
		.toBe(decided.revision);
	let persisted = (await persistedConversation(port, room))!;
	expect(persisted.events.filter(event => event.type === "decision.recorded"))
		.toEqual(decided.events.filter(event => event.type === "decision.recorded"));
	await bo.reload();
	await expect(bo.locator(`[data-chat-message-id="${recommendationId}"]`)).toBeVisible();
	await expect(bo.locator("[data-decision-prompt]")).toContainText(
		`Decided: ${EMAIL_RECOMMENDATION} · ana`,
	);
});

test("a writer can apply a focused Copilot subspan as an option", async ({ join, room, baseURL, browser }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	for (let page of [ana, bo]) await openJevWire(page, room);

	await sendChat(ana, AGENT_ACCESS_QUESTION);
	await stateWith(bo, "card.linked");
	let beforeExcerpt = (await wireState(ana))!.threads[0]!;
	let messageId = await sendChat(ana, HELD_AGENT_ACCESS);
	await expect.poll(async () => {
		let analysis = (await wireState(bo))?.analysis.find(item => item.messageId === messageId);
		return analysis?.outcomes?.some(item => item.status === "ignored") ?? false;
	}).toBe(true);
	let readerContext = await readonlyReader(browser, baseURL!, room);
	let reader = readerContext.page;
	await openJevWire(reader, room);
	let readerMessage = reader.locator(`[data-chat-message-id="${messageId}"]`);
	let readerReview = readerMessage.getByRole("button", { name: "Review 1 excerpt" });
	await expect(readerReview).toBeVisible();
	await readerReview.click();
	let readerPanel = reader.locator(`[data-analysis-message="${messageId}"]`);
	await expect(readerPanel.getByRole("button", { name: "Add to card" })).toBeDisabled();
	await expect(readerPanel.getByRole("button", { name: "Add excerpt" })).toHaveCount(0);

	let writerMessage = ana.locator(`[data-chat-message-id="${messageId}"]`);
	let review = writerMessage.getByRole("button", { name: "Review 1 excerpt" });
	await expect(review).toBeVisible();
	let writerPanel = ana.locator(`[data-analysis-message="${messageId}"]`);
	await writerMessage.hover();
	await expect(writerPanel).toBeVisible();
	await review.click();
	let addToCard = writerPanel.getByRole("button", { name: "Add to card" });
	await expect(addToCard).toBeFocused();
	await addToCard.click();
	await expect(writerPanel.getByLabel("Contribution type")).toBeFocused();
	await writerPanel.getByLabel("Contribution type").selectOption("option");
	await writerPanel.getByLabel("Decision card").selectOption({ label: AGENT_ACCESS_QUESTION });
	await writerPanel.getByLabel("Exact text").fill("Copilot");
	let originalPanelStyle = await writerPanel.getAttribute("style");
	await writerPanel.evaluate(node => {
		node.style.maxHeight = "none";
		node.style.height = "auto";
		node.style.left = "calc(100vw - 560px)";
		node.style.top = "16px";
		node.style.width = "540px";
	});
	await ana.screenshot({
		path: "docs/prototypes/conversation-plan/decision-cards/screenshots/stress-review-excerpt.png",
	});
	await writerPanel.evaluate((node, style) => {
		if (style === null) node.removeAttribute("style");
		else node.setAttribute("style", style);
	}, originalPanelStyle);
	await writerPanel.getByRole("button", { name: "Add excerpt" }).click();

	let corrected = await stateWith(bo, "option.added");
	let thread = corrected.threads.find(item => item.id === beforeExcerpt.id)!;
	let copilotOption = thread.contributions.find(item =>
		item.kind === "option"
		&& item.sources.some(source => source.messageId === messageId && source.quote === "Copilot")
	)!;
	expect(copilotOption).toMatchObject({
		text: "Copilot",
		authoring: "quoted",
		sources: [{
			messageId,
			quote: "Copilot",
			start: HELD_AGENT_ACCESS.indexOf("Copilot"),
			end: HELD_AGENT_ACCESS.indexOf("Copilot") + "Copilot".length,
			role: "option",
		}],
	});
	await writerPanel.getByRole("button", { name: "Add another excerpt" }).click();
	await writerPanel.getByLabel("Exact text").fill("bring-your-own API keys");
	await writerPanel.getByRole("button", { name: "Add excerpt" }).click();
	let withBothSubspans = await stateWith(bo, "option.added", 2);
	let byoOption = withBothSubspans.threads.find(item => item.id === beforeExcerpt.id)!
		.contributions.find(item =>
			item.kind === "option"
			&& item.sources.some(source =>
				source.messageId === messageId && source.quote === "bring-your-own API keys"
			)
		)!;
	expect(byoOption).toMatchObject({
		text: "bring-your-own API keys",
		authoring: "quoted",
		sources: [{
			messageId,
			quote: "bring-your-own API keys",
			start: HELD_AGENT_ACCESS.indexOf("bring-your-own API keys"),
			end: HELD_AGENT_ACCESS.indexOf("bring-your-own API keys") + "bring-your-own API keys".length,
			role: "option",
		}],
	});

	await Promise.all([ana.reload(), bo.reload(), reader.reload()]);
	for (let page of [ana, bo, reader]) {
		await openJevWire(page, room);
		await expect.poll(async () => {
			let state = await wireState(page);
			return state?.threads.find(item => item.id === beforeExcerpt.id)?.contributions.some(item =>
				item.kind === "option"
				&& item.sources.some(source =>
					source.messageId === messageId && source.quote === "bring-your-own API keys"
				)
			) ?? false;
		}).toBe(true);
		let restored = (await wireState(page))!;
		let restoredOption = restored.threads.find(item => item.id === beforeExcerpt.id)!
			.contributions.find(item => item.id === byoOption.id)!;
		expect(restoredOption.sources[0]).toMatchObject({
			messageId,
			quote: "bring-your-own API keys",
			start: HELD_AGENT_ACCESS.indexOf("bring-your-own API keys"),
			end: HELD_AGENT_ACCESS.indexOf("bring-your-own API keys") + "bring-your-own API keys".length,
			role: "option",
		});
		let excerptMessage = page.locator(`[data-chat-message-id="${messageId}"]`);
		let inspect = excerptMessage.getByRole("button", { name: /Analysis for message:/ });
		await inspect.focus();
		await page.keyboard.press("Enter");
		let restoredPanel = page.locator(`[data-analysis-message="${messageId}"]`);
		await expect(restoredPanel.getByText("Added to card", { exact: true })).toBeVisible();
		let addAnother = restoredPanel.getByRole("button", { name: "Add another excerpt" });
		if (page === reader) await expect(addAnother).toBeDisabled();
		else await expect(addAnother).toBeEnabled();
	}
	await readerContext.context.close();
});
