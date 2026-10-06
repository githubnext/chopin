import { authenticate, expect, roomPath, test } from "./room";
import { openJevWire, sendChat, wireRequest, wireState } from "./jev-wire";
import { RESEARCH_MESSAGES } from "./research-scenarios";

test.skip(
	process.env.E2E_RESEARCH_OFFERS !== "1",
	"Run with E2E_RESEARCH_OFFERS=1 and the isolated Jev HTTP fixture",
);

test("research-only discussion creates a shared editable offer with sourced additions and durable dismissal", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await sendChat(ana, RESEARCH_MESSAGES.propose);
	let card = ana.getByRole("group", { name: "Research suggestion", exact: true });
	await expect(card).toBeVisible();
	await expect(card.getByRole("button", { name: "Start research", exact: true })).toBeDisabled();
	expect((await wireState(ana))?.threads).toEqual([]);
	await card.getByRole("button", { name: "Edit brief", exact: true }).click();
	await card.getByRole("textbox", { name: "Research brief", exact: true }).fill(
		"Compare self-hosted alternatives to Jev for chat classification.",
	);
	await expect(bo.getByRole("group", { name: "Research suggestion", exact: true })).toContainText(
		"Compare self-hosted alternatives",
	);
	let later = await sendChat(ana, RESEARCH_MESSAGES.constraint);
	await expect(card.getByText("Suggested addition", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Add to brief", exact: true }).click();
	await expect(card.getByRole("textbox", { name: "Research brief", exact: true })).toHaveValue(
		/We also need self-hosted options/,
	);
	expect(
		await ana.locator("[data-chat-stack]").evaluate((stack, id) => {
			let message = stack.querySelector(`[data-chat-message-id="${id}"]`)!;
			let offer = stack.querySelector("[data-research-offer]")!;
			return !!(message.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING);
		}, later),
	).toBe(true);
	await bo.reload();
	await expect(bo.getByRole("group", { name: "Research suggestion", exact: true })).toContainText(
		"We also need self-hosted options",
	);
	await bo.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(card.getByText("Dismissed", { exact: true })).toBeVisible();
	await sendChat(ana, RESEARCH_MESSAGES.repeat);
	await expect.poll(async () => (await wireState(ana))?.research?.analysis.at(-1)?.policyGate).toBe(
		"dismissed research topic",
	);
	await sendChat(ana, RESEARCH_MESSAGES.renew);
	await expect(ana.getByRole("group", { name: "Research suggestion", exact: true })).toHaveCount(2);
});

test("a repository reader can observe research but cannot edit its shared draft", async ({ join, room, browser, baseURL }) => {
	let writer = await join("ana");
	await openJevWire(writer, room);
	await sendChat(writer, RESEARCH_MESSAGES.propose);
	await expect(writer.getByRole("group", { name: "Research suggestion", exact: true }))
		.toBeVisible();
	let id = (await wireState(writer))!.researchOffers![0]!.id;
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(reader.getByRole("group", { name: "Research suggestion", exact: true }))
			.toBeVisible();
		await expect(reader.getByRole("button", { name: "Edit brief", exact: true })).toHaveCount(0);
		await openJevWire(reader, room);
		let result = await wireRequest(reader, {
			kind: "conversation-plan:research-edit",
			offerId: id,
			operation: { kind: "begin" },
		});
		expect(result.kind).toBe("session:error");
	} finally {
		await context.close();
	}
});

test("repository-only questions explain the rejected research scope without creating an offer", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, RESEARCH_MESSAGES.local);
	await expect.poll(async () => (await wireState(page))?.research?.analysis.at(-1)?.policyGate)
		.toBe("External suitability below threshold: 3%; required 80%.");
	await page.locator(`[data-chat-message-id="${messageId}"]`).getByRole("button", {
		name: /Analysis for message/,
	}).click();
	await expect(page.getByRole("region", { name: "Research analysis", exact: true })).toContainText(
		"External suitability below threshold: 3%; required 80%.",
	);
	await expect(page.getByRole("group", { name: "Research suggestion", exact: true })).toHaveCount(
		0,
	);
});

test("a borderline explicit research proposal produces an offer with its admission diagnostics", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, RESEARCH_MESSAGES.borderline);
	await expect(page.getByRole("group", { name: "Research suggestion", exact: true })).toBeVisible();
	await page.locator(`[data-chat-message-id="${messageId}"]`).getByRole("button", {
		name: /Analysis for message/,
	}).click();
	let diagnostics = page.getByRole("region", { name: "Research analysis", exact: true });
	await expect(diagnostics).toContainText("Policy research-admission-2");
	await expect(diagnostics).toContainText("Admission path: Explicit proposal");
	await expect(diagnostics).toContainText("79% (minimum 70%; met)");
	await expect(diagnostics).toContainText("Subject clarity (explicit + contextual)");
	await expect(diagnostics).toContainText("87% (minimum 80%; met)");
	let state = await wireState(page);
	expect(state!.researchOffers![0]!.status).toBe("offered");
	expect(state!.researchOffers![0]!.action).toBeUndefined();
});
