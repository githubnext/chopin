import { openJevWire, sendChat, wireFrames, wireState } from "./jev-wire";
import { authenticate, content, expect, roomPath, test } from "./room";
import { seedChildChannel } from "./database";

import type { Page } from "@playwright/test";

async function waitForEvent(page: Page, type: string, count = 1) {
	await expect.poll(async () =>
		(await wireState(page))?.events.filter(event => event.type === type).length
	).toBe(count);
	return (await wireState(page))!;
}

function decisionCard(page: Page, question = "Should we ship a small pilot?") {
	return page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]')
		.filter({
			has: page.getByRole("heading", { name: question }),
		});
}

async function expectOpenCardReadOnly(card: ReturnType<typeof decisionCard>) {
	await expect(card.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	let add = card.getByRole("button", { name: "Add an option", exact: true });
	await expect(add).toBeDisabled();
}

test("Chat analysis diagnostics float without moving a bottom message", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, "Should we ship a small pilot?");
	await waitForEvent(page, "thread.opened");
	let message = page.locator(`[data-chat-message-id="${messageId}"]`);
	let inspect = message.getByRole("button", { name: /Analysis for message/ });
	let transcript = message.locator("xpath=ancestor::*[@data-focus-boundary][1]");
	await expect(inspect).toBeVisible();
	await message.hover();
	let before = await message.boundingBox();
	let scrollTop = await transcript.evaluate(element => element.scrollTop);
	expect(before).not.toBeNull();
	let popover = page.getByLabel("Message analysis");
	await expect(popover).toHaveCount(0);
	await inspect.click();
	await expect(popover).toBeVisible();
	let after = await message.boundingBox();
	expect(after).not.toBeNull();
	expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
	expect(await transcript.evaluate(element => element.scrollTop)).toBe(scrollTop);
	await expect(page.locator("[data-chat-stack] [data-analysis-popover]")).toHaveCount(0);
	let popoverBox = await popover.boundingBox();
	let composerBox = await page.locator(".chat-composer").boundingBox();
	expect(popoverBox).not.toBeNull();
	expect(composerBox).not.toBeNull();
	expect(popoverBox!.height).toBeLessThanOrEqual(352);
	expect(await popover.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(composerBox!.y);
});

test("another message hover stays quiet and code buttons keep one analysis portal", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let earlierId = await sendChat(page, "Maybe that?");
	await expect.poll(async () =>
		(await wireState(page))?.analysis.find(item => item.messageId === earlierId)?.status
	).toBe("unlinked");
	let activeId = await sendChat(page, "Should we ship a small pilot?");
	await waitForEvent(page, "thread.opened");
	let earlier = page.locator(`[data-chat-message-id="${earlierId}"]`);
	let active = page.locator(`[data-chat-message-id="${activeId}"]`);
	let popover = page.locator(`[data-analysis-message="${activeId}"]`);
	await active.getByRole("button", { name: /Analysis for message/ }).click();
	await expect(popover).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(popover).toBeVisible();
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(1);
	await popover.getByText("Model answers and run details").click();
	await expect(popover).toContainText("targeting");
	await popover.getByRole("button", { name: "Close analysis" }).click();
	await earlier.hover();
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
	await earlier.getByRole("button", { name: /Analysis for message/ }).click();
	await expect(popover).toHaveCount(0);
	await expect(page.locator(`[data-analysis-message="${earlierId}"]`)).toBeVisible();
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(1);
	await page.mouse.click(0, 0);
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
	await earlier.hover();
	await expect(page.locator("[data-analysis-popover]")).toHaveCount(0);
});

test("analysis Escape dismisses before compact Chat and narrow split popovers stay in Chat", async ({ join, room }) => {
	let page = await join("ana", { viewport: { width: 390, height: 900 } });
	await openJevWire(page, room);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	let compactMessage = await sendChat(page, "Should we ship a small pilot?");
	await waitForEvent(page, "thread.opened");
	let compactMarker = page.locator(`[data-chat-message-id="${compactMessage}"]`)
		.getByRole("button", { name: /Analysis for message/ });
	let analysis = page.getByLabel("Message analysis");
	await compactMarker.focus();
	await expect(analysis).toHaveCount(0);
	await compactMarker.press("Enter");
	await expect(analysis).toBeVisible();
	await compactMarker.press("Escape");
	await expect(analysis).toBeHidden();
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	await compactMarker.press("Escape");
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeHidden();

	await page.setViewportSize({ width: 1100, height: 900 });
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
	let splitMessage = await sendChat(page, "Could we use a small pilot?");
	let splitMessageElement = page.locator(`[data-chat-message-id="${splitMessage}"]`);
	let splitMarker = splitMessageElement
		.getByRole("button", { name: /Analysis for message/ });
	await expect(splitMarker).toBeVisible();
	await page.mouse.move(0, 0);
	await splitMessageElement.hover();
	await expect(analysis).toHaveCount(0);
	await splitMarker.click();
	await expect(analysis).toBeVisible();
	let [popoverBox, chatBox] = await Promise.all([
		analysis.boundingBox(),
		page.getByRole("complementary", { name: "Chat" }).boundingBox(),
	]);
	expect(popoverBox).not.toBeNull();
	expect(chatBox).not.toBeNull();
	expect(popoverBox!.x).toBeGreaterThanOrEqual(chatBox!.x);
	expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width);
});

test("a chat question becomes an inline decision card", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let editor = content(page);
	await editor.click();
	await page.evaluate(() => {
		(window as typeof window & { __originalEditor?: Element | null }).__originalEditor = document
			.querySelector('[role="textbox"][aria-label="editable markdown"]');
	});
	let questionMessage = await sendChat(page, "Should we ship a small pilot?");
	await waitForEvent(page, "thread.opened");
	await expect(editor).toBeFocused();
	expect(
		await page.evaluate(() =>
			document.querySelector('[role="textbox"][aria-label="editable markdown"]')
				=== (window as typeof window & { __originalEditor?: Element | null }).__originalEditor
		),
	).toBe(true);
	let compoundMessage = await sendChat(
		page,
		"Start with a small pilot. **Keep the pilot accessible to keyboard-only users.**",
	);
	let state = await waitForEvent(page, "constraint.added");
	let thread = state.threads[0]!;
	let option = thread.contributions.find(item => item.kind === "option")!;
	let card = decisionCard(page);
	await expect(card).toBeVisible();
	await expect(card.getByRole("radio", { name: "Start with a small pilot." })).toBeVisible();
	await expect(card.locator("fieldset")).toHaveCount(1);
	await expect(card.getByRole("list")).toHaveCount(0);
	await expect(page.locator(`[data-chat-message-id="${questionMessage}"] [data-message-markers]`))
		.toBeAttached();
	let compound = page.locator(`[data-chat-message-id="${compoundMessage}"]`);
	await expect(compound.locator(`[data-card-link="${option.id}"]`)).toHaveCount(0);
	let inspect = compound.getByRole("button", { name: /Analysis for message/ });
	await inspect.press("Enter");
	let analysis = page.getByLabel("Message analysis");
	let cardLink = analysis.locator(`[data-card-link="${option.id}"]`);
	await expect(cardLink).toHaveText("Proposal");
	await cardLink.click();
	await expect(analysis).toHaveCount(0);
	await expect(card).toBeFocused();
	await card.getByRole("button", { name: "Show source in chat" }).click();
	await expect(page.locator(`[data-chat-message-id="${questionMessage}"]`))
		.toHaveAttribute("data-source-exact", "true");
	await expect.poll(() => page.evaluate(() => CSS.highlights.has("conversation-source"))).toBe(
		true,
	);

	await inspect.focus();
	await expect(analysis).toHaveCount(0);
	await inspect.press("Enter");
	await expect(analysis).toContainText("findings applied");
	await analysis.getByText("Model answers and run details").click();
	await expect(analysis).toContainText("targeting");
	await analysis.getByRole("button", { name: "Close analysis" }).click();
	await expect(analysis).toHaveCount(0);
	await expect(inspect).toBeFocused();
	await inspect.press("Space");
	await expect(analysis).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(analysis).toHaveCount(0);
	await expect(inspect).toBeFocused();
	await inspect.press("Enter");
	let close = analysis.getByRole("button", { name: "Close analysis" });
	await close.focus();
	await close.press("Tab");
	let keyboardCardLink = analysis.locator(`[data-card-link="${option.id}"]`);
	await expect(keyboardCardLink).toBeFocused();
	await keyboardCardLink.press("Enter");
	await expect(analysis).toHaveCount(0);
	await expect(card).toBeFocused();
	let unlinkedMessage = await sendChat(page, "Maybe that?");
	await expect.poll(async () =>
		(await wireState(page))?.analysis.find(item => item.messageId === unlinkedMessage)?.status
	).toBe("unlinked");
	let unlinked = page.locator(`[data-chat-message-id="${unlinkedMessage}"]`);
	await expect(unlinked.getByRole("button", { name: "Analysis for message: unlinked" }))
		.toBeVisible();
	await expect(unlinked.getByRole("button", { name: "Analysis for message: unlinked" }))
		.toHaveAttribute("data-analysis-trigger", "true");
	await expect(page.getByText("Unlinked", { exact: true })).toHaveCount(0);
});

test("mounted parent and child transcripts keep their own source ranges", async ({ baseURL, join, room }) => {
	let childTitle = `Highlighted child ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		childTitle,
		"# Child document\n",
	);
	let page = await join("ana");
	await openJevWire(page, room);
	let parentMessageId = await sendChat(page, "Should we ship a small pilot?");
	let parentState = await waitForEvent(page, "thread.opened");
	await page.clock.install();
	await page.clock.pauseAt(Date.now() + 100);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await parent.getByRole("button", { name: "Show source in chat" }).click();
	let highlightedRooms = () =>
		page.evaluate(() =>
			Array.from(CSS.highlights.get("conversation-source") ?? [], range => {
				let start = range.startContainer;
				let element = start instanceof Element ? start : start.parentElement;
				return element?.closest("[data-workspace-room]")?.getAttribute("data-workspace-room");
			})
		);
	await expect.poll(highlightedRooms).toEqual([room]);
	await page.getByRole("complementary", { name: "Projects" }).getByRole("link", {
		name: childTitle,
		exact: true,
	}).click();
	let childWorkspace = page.locator(`[data-workspace-room="${child.id}"]`);
	await expect(childWorkspace).toBeVisible();
	await openJevWire(page, child.id);
	let childMessageId = await sendChat(page, "Should we ship a small pilot?");
	let childState = await waitForEvent(page, "thread.opened");
	expect(childState.threads[0]?.id).not.toBe(parentState.threads[0]?.id);
	await childWorkspace.getByRole("button", { name: "Show source in chat" }).click();
	await expect.poll(highlightedRooms).toEqual([room, child.id]);
	await expect(parent.locator(`[data-chat-message-id="${parentMessageId}"]`))
		.toHaveAttribute("data-source-exact", "true");
	await expect(childWorkspace.locator(`[data-chat-message-id="${childMessageId}"]`))
		.toHaveAttribute("data-source-exact", "true");
	await page.getByRole("button", { name: `Close ${childTitle}` }).click();
	await page.clock.runFor(500);
	await expect.poll(highlightedRooms).toEqual([room]);
	await expect(childWorkspace).toHaveCount(0);
	await page.clock.runFor(1_500);
	await parent.getByRole("button", { name: "Show source in chat" }).click();
	await page.clock.runFor(1_001);
	await expect.poll(highlightedRooms).toEqual([room]);
	await page.clock.runFor(2_000);
	await expect.poll(highlightedRooms).toEqual([]);
	let parentMessage = parent.locator(`[data-chat-message-id="${parentMessageId}"]`);
	await expect(parentMessage).not.toHaveAttribute("data-source-exact", "true");
	await expect(parentMessage.locator("[data-source-preview]")).toHaveCount(0);
});

test("an inline card arriving keeps the typist's caret", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	let editor = content(ana);
	await editor.click();
	await ana.keyboard.type("A local draft survives the incoming decision.");
	await sendChat(bo, "Should we ship a small pilot?");
	await waitForEvent(ana, "thread.opened");
	let card = decisionCard(ana);
	await expect(card).toBeVisible();
	await expect(editor).toBeFocused();
	await expect(editor).toContainText("A local draft survives the incoming decision.");
});

test("a proposal to settle pre-selects the option until a person saves", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await waitForEvent(ana, "thread.opened");
	await sendChat(bo, "Start with a small pilot.");
	await waitForEvent(ana, "option.added");
	let card = decisionCard(ana);
	let option = card.getByRole("radio", { name: "Start with a small pilot." });
	await expect(option).not.toBeChecked();

	await sendChat(bo, "Let's just go with a small pilot.");
	await waitForEvent(ana, "settle.suggested");
	await expect(option).toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toBeVisible();
	await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

	await card.getByRole("button", { name: "Save", exact: true }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		origin: "human",
		actor: { kind: "member", handle: "ana" },
	});
});

test("a human choice overrides an advisory chat suggestion", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await waitForEvent(ana, "thread.opened");
	await sendChat(bo, "Start with a small pilot.");
	let withOption = await waitForEvent(ana, "option.added");
	let humanOptionId = withOption.threads[0]!.contributions.find(item => item.kind === "option")!.id;
	let card = decisionCard(ana);
	await card.getByRole("button", { name: "Add an option", exact: true }).click();
	await card.getByRole("textbox", { name: "New option" }).fill("Ship to everyone");
	await ana.keyboard.press("Enter");
	let suggestion = card.getByRole("radio", { name: "Ship to everyone" });
	await expect(suggestion).toBeVisible();
	await sendChat(bo, "Let's just go with Ship to everyone.");
	await waitForEvent(ana, "settle.suggested");
	await expect(suggestion).toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toBeVisible();
	let humanChoice = card.getByRole("radio", { name: "Start with a small pilot." });
	await card.getByText("Start with a small pilot.", { exact: true }).click();
	await expect(humanChoice).toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toHaveCount(0);
	await card.getByRole("button", { name: "Save", exact: true }).click();
	let decided = await waitForEvent(ana, "decision.recorded");
	expect(decided.threads[0]!.decision).toMatchObject({
		optionId: humanOptionId,
		actor: { kind: "member", handle: "ana" },
	});
});

test("typing an option before a suggestion keeps the composer intent until Escape", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await waitForEvent(ana, "thread.opened");
	await sendChat(bo, "Start with a small pilot.");
	await waitForEvent(ana, "option.added");
	let card = decisionCard(ana);
	let option = card.getByRole("radio", { name: "Start with a small pilot." });
	await card.getByRole("button", { name: "Add an option", exact: true }).click();
	let field = card.getByRole("textbox", { name: "New option" });
	await field.fill("Ship to everyone");
	await sendChat(bo, "Let's just go with a small pilot.");
	await waitForEvent(ana, "settle.suggested");
	await expect(field).toBeFocused();
	await expect(field).toHaveValue("Ship to everyone");
	await expect(option).not.toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toHaveCount(0);
	await field.press("Escape");
	let add = card.getByRole("button", { name: "Add an option", exact: true });
	await expect(add).toBeFocused();
	await expect(option).toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toBeVisible();
});

test("adding an option does not suppress a later chat suggestion", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await waitForEvent(ana, "thread.opened");
	await sendChat(bo, "Start with a small pilot.");
	await waitForEvent(ana, "option.added");
	let card = decisionCard(ana);
	await card.getByRole("button", { name: "Add an option", exact: true }).click();
	await card.getByRole("textbox", { name: "New option" }).fill("Ship to everyone");
	await ana.keyboard.press("Enter");
	await expect(card.getByRole("radio", { name: "Ship to everyone" })).toBeVisible();

	await sendChat(bo, "Let's just go with Ship to everyone.");
	await waitForEvent(ana, "settle.suggested");
	await expect.poll(async () => {
		let meta = (await wireFrames(ana)).findLast(frame => frame.kind === "question:meta")?.meta as
			| { suggested?: { optionId: string } }
			| undefined;
		return meta?.suggested?.optionId;
	}).toEqual(expect.any(String));
	let meta = (await wireFrames(ana)).findLast(frame => frame.kind === "question:meta")?.meta as {
		suggested: { optionId: string };
	};
	let label = (await wireState(ana))!.threads[0]!.contributions
		.find(item => item.id === meta.suggested.optionId)?.text;
	expect(label).toBeTruthy();
	await expect(card.getByRole("radio", { name: label! })).toBeChecked();
	await expect(card.getByRole("radio", { name: "Start with a small pilot." })).not.toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toBeVisible();
});

test("failed analysis retries in Chat while editor selection survives hiding Chat", async ({ join, room, seed }) => {
	await seed("# Rich document\n\nA selected sentence.\n");
	let page = await join("ana");
	await openJevWire(page, room);
	let failureMessage = await sendChat(page, "Could we test with one team first?");
	await expect.poll(async () =>
		(await wireState(page))?.analysis.find(item => item.messageId === failureMessage)?.status
	).toBe("failed");
	let message = page.locator(`[data-chat-message-id="${failureMessage}"]`);
	let inspect = message.getByRole("button", { name: /Analysis for message/ });
	await message.locator("[data-chat-message-text]").click();
	let analysis = page.getByLabel("Message analysis");
	await expect(analysis).toHaveCount(0);
	await inspect.click();
	let close = analysis.getByRole("button", { name: "Close analysis" });
	let retry = analysis.getByRole("button", { name: "Retry analysis" });
	await expect(retry).toBeVisible();
	await expect(close).toBeFocused();
	await close.press("Tab");
	let details = analysis.getByText("Model answers and run details");
	await expect(details).toBeFocused();
	await details.press("Tab");
	await expect(retry).toBeFocused();
	await retry.press("Enter");
	await waitForEvent(page, "thread.opened");
	await expect(analysis).toContainText("finding applied");
	await expect(page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]'))
		.toBeVisible();

	let editor = content(page);
	await editor.click();
	await page.keyboard.press("ControlOrMeta+A");
	let selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
	expect(selected).toContain("selected sentence");
	await page.getByRole("button", { name: /Hide chat pane/ }).click();
	await page.getByRole("button", { name: /Show chat pane/ }).click();
	await expect(editor).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
		.toContain("selected sentence");
});

test("a second acknowledged retry uses a fresh action after analysis fails again", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, "Could we retry a flaky question twice?");
	await expect.poll(async () =>
		(await wireState(page))?.queue.find(item => item.messageId === messageId)?.status
	).toBe("failed");
	let marker = page.locator(`[data-chat-message-id="${messageId}"]`);
	await marker.locator("[data-chat-message-text]").click();
	let analysis = page.getByLabel("Message analysis");
	await expect(analysis).toHaveCount(0);
	await marker.getByRole("button", { name: /Analysis for message/ }).click();
	await analysis.getByRole("button", { name: "Retry analysis" }).click();
	await expect.poll(async () =>
		(await wireState(page))?.queue.find(item => item.messageId === messageId)
	).toMatchObject({ status: "failed", attempts: 1 });
	await analysis.getByRole("button", { name: "Retry analysis" }).click();
	await waitForEvent(page, "thread.opened");
	await expect.poll(async () =>
		(await wireState(page))?.queue.some(item => item.messageId === messageId)
	).toBe(false);
});

test("scrolling a pinned message analysis out of Chat dismisses its portal", async ({ join, room }) => {
	let page = await join("ana");
	await openJevWire(page, room);
	let messageId = await sendChat(page, "Should we ship a small pilot?");
	await waitForEvent(page, "thread.opened");
	let marker = page.locator(`[data-chat-message-id="${messageId}"]`);
	await marker.locator("[data-chat-message-text]").click();
	let analysis = page.locator(`[data-analysis-message="${messageId}"]`);
	await expect(analysis).toHaveCount(0);
	await marker.getByRole("button", { name: /Analysis for message/ }).click();
	await expect(analysis).toBeVisible();
	for (let index = 0; index < 32; index++) await sendChat(page, `Maybe that? ${index}`);
	let transcript = marker.locator("xpath=ancestor::*[@data-focus-boundary][1]");
	await transcript.evaluate(element => element.scrollTop = element.scrollHeight);
	await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect.poll(() =>
		marker.evaluate(element => {
			let transcript = element.closest("[data-focus-boundary]");
			if (!transcript) return false;
			return element.getBoundingClientRect().bottom <= transcript.getBoundingClientRect().top;
		})
	).toBe(true);
	await expect(analysis).toBeHidden();
});

test("read-only and archived readers keep cards and diagnostics with disabled controls", async ({ baseURL, browser, join, room }) => {
	let writer = await join("ana");
	await openJevWire(writer, room);
	let messageId = await sendChat(writer, "Should we ship a small pilot?");
	await waitForEvent(writer, "thread.opened");
	let readonlyContext = await browser.newContext({ baseURL });
	try {
		let reader = await readonlyContext.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await expect(decisionCard(reader)).toBeVisible();
		await expectOpenCardReadOnly(decisionCard(reader));
		let marker = reader.locator(`[data-chat-message-id="${messageId}"]`);
		await decisionCard(reader).getByRole("button", { name: "Show source in chat" }).click();
		await expect(marker).toHaveAttribute("data-source-exact", "true");
		await marker.locator("[data-chat-message-text]").click();
		let analysis = reader.getByLabel("Message analysis");
		await expect(analysis).toHaveCount(0);
		await marker.getByRole("button", { name: /Analysis for message/ }).click();
		await expect(analysis).toContainText("finding applied");
		await analysis.getByText("Model answers and run details").click();
		await expect(analysis).toContainText("triage");
	} finally {
		await readonlyContext.close();
	}
	let archived = await writer.request.post(`/api/channels/${room}/archive`, {
		headers: { origin: baseURL! },
	});
	expect(archived.status()).toBe(200);
	await expectOpenCardReadOnly(decisionCard(writer));
	await writer.reload();
	await expect(content(writer)).toHaveAttribute("contenteditable", "false");
	await expect(decisionCard(writer)).toBeVisible();
	await expectOpenCardReadOnly(decisionCard(writer));
});
