/**
 * A reader's reaction to the Planner's message starts a real Planner turn, with no tools. The
 * turn is queued, busy, stopped and published like any other, under the owner the document already
 * has, and it claims no owner for the reader. The scripted Planner answers a turn with no tools with
 * a fixed line, and fails the turn if it is offered a tool.
 */
import { chatInput } from "./chat-input";
import { readPlannerOwner } from "./database";
import { READER_REPLY } from "./harness/fixtures";
import { authenticate, expect, roomPath, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const PLANNER = { id: "message-planner", text: "I moved the cache key into the router." };
const REPLY = "Plan: Reaction harness.";
const DOCUMENT = "# Reaction harness\nThe cache lives in the router.\n";

function transcript() {
	return [
		{
			id: "message-person",
			author: { kind: "member", handle: "ben" },
			text: "The cache is keyed by the request path.",
			ts: 1_700_000_001,
		},
		{ id: PLANNER.id, author: { kind: "agent" }, text: PLANNER.text, ts: 1_700_000_002 },
	];
}

function chatOf(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chatOf(page).locator(`[data-chat-message-id="${id}"]`);
}

async function explainThis(page: Page): Promise<void> {
	let target = message(page, PLANNER.id);
	await target.hover();
	await target.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: "Explain this",
		exact: true,
	}).click();
	await expect(target.getByRole("button", { name: "You reacted with ❓" })).toHaveText("❓1");
}

async function recordChat(page: Page) {
	let seen: Array<{ order: number; frame: Chat.Outgoing }> = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Outgoing;
				if (frame.kind.startsWith("chat:")) seen.push({ order: seen.length, frame });
			}
			route.send(message);
		});
	});
	return {
		all: () => seen,
		of: <K extends Chat.Outgoing["kind"]>(kind: K) =>
			seen.filter(item => item.frame.kind === kind) as Array<
				{ order: number; frame: Extract<Chat.Outgoing, { kind: K }> }
			>,
	};
}

function portOf(baseURL: string | undefined): number {
	return Number(new URL(baseURL!).port);
}

async function openAsReader(page: Page, baseURL: string | undefined, room: string): Promise<void> {
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	await expect(page.getByText("You have read-only access to this document.")).toBeVisible();
	await expect(page.getByPlaceholder("Use @chopin to ask Chopin")).toHaveCount(0);
	await expect(message(page, PLANNER.id)).toBeVisible();
}

async function plannerAnswers(writer: Page): Promise<void> {
	let chat = chatOf(writer);
	await chatInput(chat).fill("@chopin read the document and latest pull request");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect(chat).toContainText(REPLY, { timeout: 60_000 });
}

test("a read-only person's ❓ makes a real Planner turn with no tools: busy for everyone, then the answer in the Chat", async ({ baseURL, join, page, room, seed }) => {
	test.setTimeout(180_000);
	await seed(DOCUMENT, { transcript: transcript() });
	let frames = await recordChat(page);
	let reader = page;
	await openAsReader(reader, baseURL, room);
	let writer = await join("ana", {});
	await plannerAnswers(writer);
	await expect.poll(() => frames.of("chat:state").at(-1)?.frame.busy).toBe(false);
	let owner = await readPlannerOwner(portOf(baseURL), room);
	expect(owner).not.toBeNull();
	let toolFrames = frames.of("chat:tool").length;
	let start = frames.all().length;

	await explainThis(reader);
	await expect(chatOf(writer)).not.toContainText(READER_REPLY);
	await expect(writer.getByRole("button", { name: "Stop generating" })).toBeVisible({
		timeout: 30_000,
	});
	await expect(chatOf(reader)).toContainText(READER_REPLY, { timeout: 60_000 });
	await expect(chatOf(writer)).toContainText(READER_REPLY);
	await expect(writer.getByRole("button", { name: "Stop generating" })).toHaveCount(0);

	let after = frames.all().slice(start);
	let busy = after.filter(item => item.frame.kind === "chat:state").map(item =>
		(item.frame as Chat.State).busy
	);
	expect(busy.length).toBeGreaterThanOrEqual(2);
	expect(busy.slice(0, -1).every(Boolean)).toBe(true);
	expect(busy.at(-1)).toBe(false);
	let answer = after.find(item =>
		item.frame.kind === "chat:message"
		&& (item.frame as Chat.Message).entry.text === READER_REPLY
	);
	expect(answer).toBeDefined();
	expect(JSON.stringify(answer!.frame)).not.toContain("viaReaction");
	expect(frames.of("chat:tool")).toHaveLength(toolFrames);
	expect(await readPlannerOwner(portOf(baseURL), room)).toBe(owner);
});

test("a stop pressed during a read-only person's turn stops it like any turn, and no answer comes", async ({ baseURL, join, page, room, seed }) => {
	test.setTimeout(180_000);
	await seed(DOCUMENT, { transcript: transcript() });
	let frames = await recordChat(page);
	let reader = page;
	await openAsReader(reader, baseURL, room);
	let writer = await join("ana", {});
	await plannerAnswers(writer);
	await explainThis(reader);
	let stop = writer.getByRole("button", { name: "Stop generating" });
	await expect(stop).toBeVisible({ timeout: 30_000 });
	await stop.click();
	await expect(chatOf(writer)).toContainText("ana stopped the turn.");
	await expect.poll(() => frames.of("chat:state").at(-1)?.frame.busy).toBe(false);
	await writer.waitForTimeout(6_000);
	await expect(chatOf(writer)).not.toContainText(READER_REPLY);
	await expect(chatOf(reader)).not.toContainText(READER_REPLY);
	expect(await readPlannerOwner(portOf(baseURL), room)).not.toBeNull();
});

test("with no Planner owner a read-only person's ❓ is kept and shown, starts nothing and claims no owner", async ({ baseURL, page, room, seed }) => {
	test.setTimeout(120_000);
	await seed(DOCUMENT, { transcript: transcript() });
	let frames = await recordChat(page);
	let reader = page;
	await openAsReader(reader, baseURL, room);
	expect(await readPlannerOwner(portOf(baseURL), room)).toBeNull();
	let before = frames.of("chat:state").length;
	await explainThis(reader);
	await reader.waitForTimeout(12_000);
	await expect(chatOf(reader)).not.toContainText(READER_REPLY);
	await expect(chatOf(reader).locator("[data-chat-message-id]")).toHaveCount(2);
	expect(frames.of("chat:state").slice(before).some(item => item.frame.busy)).toBe(false);
	expect(await readPlannerOwner(portOf(baseURL), room)).toBeNull();
});
