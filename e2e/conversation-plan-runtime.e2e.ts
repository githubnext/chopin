import { createChannel } from "./database";
import { releaseJev, resetJevControl } from "./jev-control";
import { RESTART_URL, startJevProcess, stopJevProcess } from "./jev-process";
import { openJevWire, sendChat, wireFrames, wireRequest, wireState } from "./jev-wire";
import { authenticate, content, expect, ready, roomPath, test } from "./room";

import type { ConversationPlan } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

async function stateWith(page: Page, eventType: ConversationPlan.Event["type"], count = 1) {
	await expect.poll(async () =>
		(await wireState(page))?.events.filter(event => event.type === eventType).length
	).toBe(count);
	return (await wireState(page))!;
}

async function sharedState(
	ana: Page,
	bo: Page,
	eventType: ConversationPlan.Event["type"],
) {
	let first = await stateWith(ana, eventType);
	await expect.poll(async () => (await wireState(bo))?.revision).toBe(first.revision);
	let second = await stateWith(bo, eventType);
	expect(second).toEqual(first);
	return first;
}

function expectSource(
	state: ConversationPlan.State,
	type: ConversationPlan.Event["type"],
	messageId: string,
	handle: string,
	quote: string,
) {
	expect(state.events.find(event => event.type === type)).toMatchObject({
		source: { messageId, author: { kind: "member", handle }, quote },
	});
}

test("two members share sourced threads and decide on the card", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);

	let questionId = await sendChat(ana, "Should we ship a small pilot?");
	await stateWith(ana, "thread.opened");
	let opened = await sharedState(ana, bo, "card.linked");
	let thread = opened.threads[0]!;
	expect(thread.questionSources[0]).toMatchObject({
		messageId: questionId,
		author: { kind: "member", handle: "ana" },
		quote: "Should we ship a small pilot?",
	});

	let optionId = await sendChat(bo, "Start with a small pilot.");
	let withOption = await sharedState(ana, bo, "option.added");
	let option = withOption.threads[0]!.contributions.find(item => item.kind === "option")!;
	expect(option.sources[0]).toMatchObject({ messageId: optionId, quote: option.text });

	let reasonId = await sendChat(ana, "A small pilot would catch setup problems early.");
	let withReason = await sharedState(ana, bo, "reason.added");
	expectSource(
		withReason,
		"reason.added",
		reasonId,
		"ana",
		"A small pilot would catch setup problems early.",
	);
	let constraintId = await sendChat(bo, "Keep the pilot accessible to keyboard-only users.");
	let withConstraint = await sharedState(ana, bo, "constraint.added");
	expectSource(
		withConstraint,
		"constraint.added",
		constraintId,
		"bo",
		"Keep the pilot accessible to keyboard-only users.",
	);
	let supportId = await sendChat(ana, "I support the small pilot.");
	let supported = await sharedState(ana, bo, "stance.changed");
	expectSource(supported, "stance.changed", supportId, "ana", "I support the small pilot.");
	let stance = supported.threads[0]!.stances[0]!;
	expect(stance).toMatchObject({ participant: "ana", optionId: option.id, position: "support" });

	let corrected = await wireRequest(bo, {
		kind: "conversation-plan:correct",
		actionId: crypto.randomUUID(),
		threadId: thread.id,
		expectedVersion: supported.threads[0]!.version,
		change: { kind: "retarget-stance", stanceId: stance.id },
		actor: { kind: "member", handle: "forged-actor" },
		source: { author: { kind: "member", handle: "forged-source" } },
	});
	expect(corrected.kind).toBe("conversation-plan:correct");
	let afterCorrection = await sharedState(ana, bo, "card.corrected");
	expect(afterCorrection.events.find(event => event.type === "card.corrected")?.actor)
		.toEqual({ kind: "member", handle: "bo" });
	expect(afterCorrection.threads[0]!.stances[0]).toMatchObject({
		participant: "ana",
		correctedBy: "bo",
	});
	expect(afterCorrection.threads[0]!.stances[0]!.optionId).toBeUndefined();

	let proposalId = await sendChat(bo, "Let's just go with a small pilot.");
	let suggested = await sharedState(ana, bo, "settle.suggested");
	expectSource(
		suggested,
		"settle.suggested",
		proposalId,
		"bo",
		"Let's just go with a small pilot.",
	);
	expect(suggested.threads[0]!.pendingSettle?.optionId).toBe(option.id);
	expect(suggested.threads[0]!.status).not.toBe("decided");

	await bo.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Decisions/ }).click();
	let card = bo.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]')
		.filter({
			has: bo.getByRole("heading", { name: "Should we ship a small pilot?" }),
		});
	await card.getByRole("button", { name: "Save", exact: true }).click();
	let decided = await sharedState(ana, bo, "decision.recorded");
	expect(decided.events.find(event => event.type === "decision.recorded")).toMatchObject({
		origin: "human",
		actor: { kind: "member", handle: "bo" },
		optionId: option.id,
	});
	expect(decided.threads[0]!.status).toBe("decided");
	let objectionId = await sendChat(
		ana,
		"I object: a small pilot will exclude keyboard-only users.",
	);
	let challenged = await sharedState(ana, bo, "candidate.proposed");
	expectSource(
		challenged,
		"candidate.proposed",
		objectionId,
		"ana",
		"I object: a small pilot will exclude keyboard-only users.",
	);
	expect(challenged.threads[0]!.status).toBe("decided");
	expect(challenged.threads[0]!.candidates[0]).toMatchObject({ kind: "reopening" });
	let reopeningId = await sendChat(bo, "Let's revisit the small pilot decision.");
	await expect.poll(async () =>
		(await wireState(bo))?.analysis.find(item => item.messageId === reopeningId)?.status
	).toBe("applied");
	let afterReopening = (await wireState(bo))!;
	expect(afterReopening.events.filter(event => event.type === "decision.reopened")).toHaveLength(0);
	expect(afterReopening.threads[0]!.status).toBe("decided");
	let eventCount = afterReopening.events.length;
	let ambiguousId = await sendChat(ana, "Maybe that?");
	await expect.poll(async () =>
		(await wireState(bo))?.analysis.find(item => item.messageId === ambiguousId)?.status
	).toBe("unlinked");
	expect((await wireState(bo))!.events).toHaveLength(eventCount);
});

test("a delayed inference leaves chat live and preserves a concurrent wording edit", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	await openJevWire(ana, room);
	await openJevWire(bo, room);
	await sendChat(ana, "Should we ship a small pilot?");
	await stateWith(ana, "thread.opened");
	let initial = await stateWith(ana, "card.linked");
	let thread = initial.threads[0]!;
	let delayed = await sendChat(bo, "Should we test with one team first?");
	let later = await sendChat(ana, "Thanks, I'll review the draft.");
	await expect.poll(async () =>
		(await wireFrames(bo)).some(frame =>
			frame.kind === "chat:message"
			&& (frame.entry as { id?: string } | undefined)?.id === later
		)
	).toBe(true);
	let waiting = (await wireState(ana))!;
	expect(waiting.events.map(event => event.type)).toEqual(["thread.opened", "card.linked"]);
	expect(waiting.queue.map(item => item.messageId)).toEqual([delayed, later]);
	expect(waiting.analysis.some(item => item.messageId === later)).toBe(false);
	let response = await wireRequest(ana, {
		kind: "conversation-plan:correct",
		actionId: crypto.randomUUID(),
		threadId: thread.id,
		expectedVersion: thread.version,
		change: { kind: "edit", field: "question", text: "Should we ship a limited pilot?" },
	});
	expect(response.kind).toBe("conversation-plan:correct");
	await releaseJev("delayed-question");
	await expect.poll(async () =>
		(await wireState(bo))?.analysis.find(item => item.messageId === delayed)?.status
	).toBe("applied");
	await expect.poll(async () =>
		(await wireState(bo))?.analysis.find(item => item.messageId === later)?.status
	).toBe("unlinked");
	let final = (await wireState(bo))!;
	expect(final.threads.find(item => item.id === thread.id)?.question)
		.toBe("Should we ship a limited pilot?");
	expect(final.events.filter(event => event.type === "thread.opened")).toHaveLength(2);
	expect(final.events.filter(event => event.type === "card.corrected")).toHaveLength(1);
});

test("failure retries once; refresh and restricted sockets preserve state", async ({ baseURL, browser, join, room }) => {
	let ana = await join("ana");
	await openJevWire(ana, room);
	let priorMessageId = await sendChat(ana, "Should we ship a small pilot?");
	await stateWith(ana, "thread.opened");
	let prior = await stateWith(ana, "card.linked");
	let priorThread = prior.threads[0]!;
	expectSource(prior, "thread.opened", priorMessageId, "ana", "Should we ship a small pilot?");
	let messageId = await sendChat(ana, "Could we test with one team first?");
	await expect.poll(async () =>
		(await wireState(ana))?.analysis.find(item => item.messageId === messageId)?.status
	).toBe("failed");
	let failed = (await wireState(ana))!;
	expect(failed.events).toEqual(prior.events);
	expect(failed.threads).toEqual([priorThread]);
	expectSource(failed, "thread.opened", priorMessageId, "ana", "Should we ship a small pilot?");
	expect((await wireFrames(ana)).some(frame =>
		frame.kind === "chat:message"
		&& (frame.entry as { id?: string } | undefined)?.id === messageId
	)).toBe(true);
	let actionId = crypto.randomUUID();
	let retry = await wireRequest(ana, { kind: "conversation-plan:retry", actionId, messageId });
	expect(retry).toMatchObject({ kind: "conversation-plan:retry", messageId });
	await stateWith(ana, "thread.opened", 2);
	let recovered = await stateWith(ana, "card.linked", 2);
	expect(recovered.threads.find(item => item.id === priorThread.id)).toEqual(priorThread);
	expectSource(recovered, "thread.opened", priorMessageId, "ana", "Should we ship a small pilot?");
	expect(recovered.events.filter(event => event.type === "thread.opened")[1]).toMatchObject({
		source: {
			messageId,
			author: { kind: "member", handle: "ana" },
			quote: "Could we test with one team first?",
		},
	});
	let stable = { events: recovered.events, threads: recovered.threads };
	let repeated = await wireRequest(ana, { kind: "conversation-plan:retry", actionId, messageId });
	expect(repeated.kind).toBe("conversation-plan:retry");
	expect((await wireState(ana))!.events).toEqual(stable.events);
	expect((await wireState(ana))!.threads).toEqual(stable.threads);

	await ana.reload();
	await ready(ana);
	await openJevWire(ana, room);
	let restored = (await wireState(ana))!;
	expect(restored.events).toEqual(stable.events);
	expect(restored.threads).toEqual(stable.threads);
	expect(restored.analysis.find(item => item.messageId === messageId)?.status).toBe("applied");
	expect((await wireFrames(ana)).find(frame => frame.kind === "chat:history")?.entries)
		.toEqual(expect.arrayContaining([expect.objectContaining({ id: messageId })]));
	let thread = restored.threads.find(item => item.id === priorThread.id)!;

	let readonlyContext = await browser.newContext({ baseURL });
	let readonly = await readonlyContext.newPage();
	await authenticate(readonly, "readonly", baseURL!);
	await readonly.goto(roomPath(room));
	await expect(content(readonly)).toHaveAttribute("contenteditable", "false");
	await openJevWire(readonly, room);
	expect((await wireState(readonly))!.events).toEqual(stable.events);
	expect((await wireState(readonly))!.threads).toEqual(stable.threads);
	expect((await wireFrames(readonly)).find(frame => frame.kind === "session:hello")?.canEdit)
		.toBe(false);
	for (
		let frame of [
			{
				kind: "conversation-plan:correct",
				actionId: crypto.randomUUID(),
				threadId: thread.id,
				expectedVersion: thread.version,
				change: { kind: "edit", field: "question", text: "No" },
			},
			{ kind: "conversation-plan:retry", actionId: crypto.randomUUID(), messageId },
		]
	) {
		let response = await wireRequest(readonly, frame);
		expect(response.kind).toBe("session:error");
		expect(response.message).toMatch(/write access/);
	}
	await readonlyContext.close();

	let archived = await ana.request.post(`/api/channels/${room}/archive`, {
		headers: { origin: baseURL! },
	});
	expect(archived.status()).toBe(200);
	await expect.poll(async () =>
		(await wireFrames(ana)).some(frame =>
			frame.kind === "session:access" && frame.canEdit === false
		)
	).toBe(true);
	await ana.reload();
	await openJevWire(ana, room);
	expect((await wireState(ana))!.events).toEqual(stable.events);
	expect((await wireState(ana))!.threads).toEqual(stable.threads);
	expect((await wireFrames(ana)).find(frame => frame.kind === "session:hello")?.archivedAt)
		.toEqual(expect.any(String));
	for (
		let frame of [
			{
				kind: "conversation-plan:correct",
				actionId: crypto.randomUUID(),
				threadId: thread.id,
				expectedVersion: thread.version,
				change: { kind: "edit", field: "question", text: "No" },
			},
			{ kind: "conversation-plan:retry", actionId: crypto.randomUUID(), messageId },
		]
	) {
		let response = await wireRequest(ana, frame);
		expect(response.kind).toBe("session:error");
		expect(response.message).toMatch(/write access/);
	}
	expect((await wireState(ana))!.events).toEqual(stable.events);
	expect((await wireState(ana))!.threads).toEqual(stable.threads);
});

test("restoring ordinary and Planner history does not enqueue inference", async ({ join, room, seed }) => {
	let humanId = crypto.randomUUID();
	let plannerId = crypto.randomUUID();
	await seed("# Historical conversation\n", {
		transcript: [
			{
				id: humanId,
				author: { kind: "member", handle: "ana" },
				text: "Should we ship a small pilot?",
				ts: Date.now(),
			},
			{
				id: plannerId,
				author: { kind: "agent" },
				text: "Start with a small pilot.",
				ts: Date.now() + 1,
			},
		],
	});
	let page = await join("ana");
	await openJevWire(page, room);
	expect((await wireRequest(page, { kind: "session:ping" })).kind).toBe("session:ping");
	let initial = (await wireState(page))!;
	expect(initial.events).toHaveLength(0);
	expect(initial.queue).toHaveLength(0);
	expect(initial.analysis).toHaveLength(0);
	expect((await wireFrames(page)).find(frame => frame.kind === "chat:history")?.entries)
		.toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: humanId,
				author: { kind: "member", handle: "ana" },
				text: "Should we ship a small pilot?",
			}),
			expect.objectContaining({
				id: plannerId,
				author: { kind: "agent" },
				text: "Start with a small pilot.",
			}),
		]));
	await page.reload();
	await openJevWire(page, room);
	expect((await wireRequest(page, { kind: "session:ping" })).kind).toBe("session:ping");
	expect((await wireState(page))!.events).toHaveLength(0);
	expect((await wireState(page))!.queue).toHaveLength(0);
	expect((await wireState(page))!.analysis).toHaveLength(0);
});

test("pending inference resumes after an actual server process restart", async ({ browser }) => {
	await resetJevControl();
	let room = crypto.randomUUID();
	await createChannel(8789, room);
	let first = await startJevProcess();
	let second: typeof first | undefined;
	let context = await browser.newContext({ baseURL: RESTART_URL });
	let replacement: typeof context | undefined;
	try {
		let page = await context.newPage();
		await authenticate(page, "ana", RESTART_URL);
		await page.goto(roomPath(room));
		await ready(page);
		await openJevWire(page, room);
		let messageId = await sendChat(page, "Should we test with one team first?");
		await expect.poll(async () =>
			(await wireState(page))?.queue.find(item => item.messageId === messageId)?.status
		).toBe("pending");
		expect((await wireState(page))!.events).toHaveLength(0);

		await stopJevProcess(first);
		await context.close();
		second = await startJevProcess();
		replacement = await browser.newContext({ baseURL: RESTART_URL });
		let reopened = await replacement.newPage();
		await authenticate(reopened, "ana", RESTART_URL);
		await reopened.goto(roomPath(room));
		await ready(reopened);
		await openJevWire(reopened, room);
		expect((await wireState(reopened))!.queue).toEqual(expect.arrayContaining([
			expect.objectContaining({ messageId, status: "pending" }),
		]));
		expect((await wireState(reopened))!.events).toHaveLength(0);
		await releaseJev("delayed-question");
		let completed = await stateWith(reopened, "thread.opened");
		expect(completed.analysis.find(item => item.messageId === messageId)?.status).toBe("applied");
		expect(completed.events.filter(event => event.type === "thread.opened")).toHaveLength(1);
		expect(completed.events.filter(event => event.type === "card.linked")).toHaveLength(1);
	} finally {
		await replacement?.close();
		await context.close();
		await stopJevProcess(second ?? first);
	}
});
