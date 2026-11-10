/**
 * A reaction to the Planner's message can make the Planner answer. The toolbar's ❓ and 👎 are read
 * in code and every other emoji by the decisions model, here the browser suite's fake; ✅, 👍, 👀 and
 * 🙌 need no answer, and a reaction to a person's message never starts a turn. The scripted Planner
 * answers with the plan's heading and the latest pull request, so a reply is a line that says "Plan:".
 */
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const PERSON = { id: "message-person", text: "The cache is keyed by the request path." };
const PLANNER = { id: "message-planner", text: "I moved the cache key into the router." };
const REPLY = "Plan: Reaction harness.";

function transcript() {
	return [
		{
			id: PERSON.id,
			author: { kind: "member", handle: "ben" },
			text: PERSON.text,
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

async function quick(page: Page, id: string, label: string): Promise<void> {
	let target = message(page, id);
	await target.hover();
	await target.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: label,
		exact: true,
	}).click();
}

async function pick(page: Page, id: string, search: string, emoji: string): Promise<void> {
	let target = message(page, id);
	await target.hover();
	await target.getByRole("toolbar", { name: "Reactions and actions" }).getByRole("button", {
		name: "Add reaction",
	}).click();
	let picker = page.getByRole("dialog", { name: "Add reaction" });
	await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill(search);
	await picker.getByRole("button", { name: emoji }).first().click();
}

test("❓ Explain this on the Planner's message makes the Planner answer in the Chat", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Reaction harness\nThe cache lives in the router.\n", { transcript: transcript() });
	let page = await join("ana");
	await expect(chatOf(page)).not.toContainText(REPLY);
	await quick(page, PLANNER.id, "Explain this");
	await expect(message(page, PLANNER.id).getByRole("button", { name: "You reacted with ❓" }))
		.toHaveText("❓1");
	await expect(chatOf(page)).toContainText(REPLY, { timeout: 60_000 });
});

test("🤔 read by the decisions model as confusion makes the Planner answer too", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Reaction harness\nThe cache lives in the router.\n", { transcript: transcript() });
	let page = await join("ana");
	await pick(page, PLANNER.id, "thinking", "🤔");
	await expect(message(page, PLANNER.id).getByRole("button", { name: "You reacted with 🤔" }))
		.toHaveText("🤔1");
	await expect(chatOf(page)).toContainText(REPLY, { timeout: 60_000 });
});

test("👍 is an acknowledgement and starts no turn, and neither does a reaction to a person's message", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Reaction harness\nThe cache lives in the router.\n", { transcript: transcript() });
	let page = await join("ana");
	await pick(page, PLANNER.id, "thumbs up", "👍");
	await expect(message(page, PLANNER.id).getByRole("button", { name: "You reacted with 👍" }))
		.toHaveText("👍1");
	await quick(page, PERSON.id, "Explain this");
	await expect(message(page, PERSON.id).getByRole("button", { name: "You reacted with ❓" }))
		.toHaveText("❓1");
	await page.waitForTimeout(12_000);
	await expect(chatOf(page)).not.toContainText(REPLY);
	await expect(chatOf(page).locator("[data-chat-message-id]")).toHaveCount(2);
});

test("a reaction taken back within the debounce starts no turn", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Reaction harness\nThe cache lives in the router.\n", { transcript: transcript() });
	let page = await join("ana");
	await quick(page, PLANNER.id, "Not quite");
	await expect(message(page, PLANNER.id).getByRole("button", { name: "You reacted with 👎" }))
		.toHaveText("👎1");
	await quick(page, PLANNER.id, "Not quite");
	await expect(message(page, PLANNER.id).getByRole("group", { name: "Reactions" })).toHaveCount(0);
	await page.waitForTimeout(12_000);
	await expect(chatOf(page)).not.toContainText(REPLY);
	await expect(chatOf(page).locator("[data-chat-message-id]")).toHaveCount(2);
});
