/**
 * Who is writing, as Slack shows it: under Chat's composer and a thread's, the people writing there
 * and never the viewer; a thread's writing on its row in Chat, never under Chat's composer; and
 * chopin writing a reaction's answer in its thread, on that thread's row in Chat until the answer
 * lands or fails. The scripted Planner answers a message holding SLOW-LIVE slowly, and fails one
 * holding SLOW-FAIL after a while.
 */
import { chatInput } from "./chat-input";
import { textContrast } from "./rendered-contrast";
import { authenticate, content, expect, roomPath, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const WIDE = { viewport: { width: 1600, height: 900 } };
const ROOT = { id: "typing-root", text: "Where should the cache key live?" };
const SLOW = { id: "slow-root", text: "I moved the cache key into the router. SLOW-LIVE" };
const FAILING = { id: "failing-root", text: "I kept the old cache key for now. SLOW-FAIL" };

function transcript() {
	return [
		{ id: ROOT.id, author: { kind: "member", handle: "cy" }, text: ROOT.text, ts: 1_700_000_001 },
		{ id: SLOW.id, author: { kind: "agent" }, text: SLOW.text, ts: 1_700_000_002 },
		{ id: FAILING.id, author: { kind: "agent" }, text: FAILING.text, ts: 1_700_000_003 },
	];
}

function main(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" })
		.locator(".chat-split-main");
}

function panelOf(page: Page): Locator {
	return page.locator("[data-thread-panel]");
}

function rowOf(scope: Locator, id: string): Locator {
	return scope.locator(`[data-chat-message-id="${id}"]`);
}

function line(scope: Locator): Locator {
	return scope.locator("[data-chat-typing]");
}

function replying(scope: Locator, id: string): Locator {
	return rowOf(scope, id).locator("[data-thread-replying] .chat-thread-summary-replying");
}

function announced(page: Page): Locator {
	return page.locator("[data-chat-typing-announcer]");
}

async function openThread(page: Page, id: string): Promise<Locator> {
	let row = rowOf(main(page), id);
	await row.hover();
	await row.getByRole("toolbar", { name: "Reactions and actions" })
		.getByRole("button", { name: "Reply in thread" }).click();
	let panel = panelOf(page);
	await expect(rowOf(panel, id)).toBeVisible();
	return panel;
}

async function clear(input: Locator): Promise<void> {
	await input.press("ControlOrMeta+a");
	await input.press("Backspace");
}

test("two people see each other writing in Chat and in a thread, never themselves, and a thread's writing on its row in Chat", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed("# Typing\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let bo = await join("bo", WIDE);
	let anaDraft = chatInput(main(ana));
	let boDraft = chatInput(main(bo));

	await anaDraft.pressSequentially("Thinking");
	await expect(line(main(bo))).toHaveText("@ana is typing…");
	await expect(announced(bo)).toHaveText("@ana is typing…");
	await expect(line(main(ana))).toHaveText("");

	await boDraft.pressSequentially("Me too");
	await expect(line(main(ana))).toHaveText("@bo is typing…");
	await expect(line(main(bo))).toHaveText("@ana is typing…");

	// Clearing the draft ends it at once, and so does leaving the field.
	await clear(anaDraft);
	await expect(line(main(bo))).toHaveText("");
	await rowOf(main(bo), ROOT.id).click();
	await expect(line(main(ana))).toHaveText("");

	// A thread's writing is said on its row in Chat, which has no reply yet, and not under Chat's composer.
	let anaPanel = await openThread(ana, ROOT.id);
	await chatInput(anaPanel).pressSequentially("Under the router");
	await expect(replying(main(bo), ROOT.id)).toHaveText("@ana is replying…");
	await expect(line(main(bo))).toHaveText("");
	await expect(replying(main(ana), ROOT.id)).toHaveCount(0);

	let boPanel = await openThread(bo, ROOT.id);
	await expect(line(boPanel)).toHaveText("@ana is typing…");
	await expect(announced(bo)).toHaveText("In the thread, @ana is typing…");
	await expect(line(main(bo))).toHaveText("");

	// Sending ends it; the row says the reply instead.
	await chatInput(anaPanel).press("Enter");
	await expect(line(boPanel)).toHaveText("");
	await expect(rowOf(main(bo), ROOT.id).locator("[data-thread-summary]")).toContainText("1 reply");
	await expect(replying(main(bo), ROOT.id)).toHaveCount(0);

	// Five seconds without an edit end it with no word from the writer.
	await anaDraft.pressSequentially("One more");
	await expect(line(main(bo))).toHaveText("@ana is typing…");
	await bo.waitForTimeout(3_000);
	await expect(line(main(bo))).toHaveText("@ana is typing…");
	await expect(line(main(bo))).toHaveText("", { timeout: 6_000 });
});

test("the typing line holds its dots still where motion is reduced and is legible on its ground", async ({ join, seed }) => {
	test.setTimeout(90_000);
	await seed("# Typing\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let bo = await join("bo", { ...WIDE, reducedMotion: "reduce" });

	await chatInput(main(ana)).pressSequentially("Thinking");
	let still = line(main(bo));
	await expect(still).toHaveText("@ana is typing…");
	let dots = still.locator(".connecting-dot");
	await expect(dots).toHaveCount(3);
	expect(await dots.first().evaluate(dot => getComputedStyle(dot).animationName)).toBe("none");
	expect(await textContrast(still.locator(".chat-typing-words"))).toBeGreaterThanOrEqual(4.5);

	await chatInput(main(bo)).pressSequentially("Me too");
	let moving = line(main(ana));
	await expect(moving).toHaveText("@bo is typing…");
	expect(
		await moving.locator(".connecting-dot").first().evaluate(dot =>
			getComputedStyle(dot).animationName
		),
	).not.toBe("none");

	let anaPanel = await openThread(ana, ROOT.id);
	await chatInput(anaPanel).pressSequentially("Under the router");
	let row = replying(main(bo), ROOT.id);
	await expect(row).toHaveText("@ana is replying…");
	expect(await textContrast(row)).toBeGreaterThanOrEqual(4.5);
});

test("chopin answering a reaction is shown replying on its thread's row in Chat until the answer lands, and not again in its thread", async ({ join, seed }) => {
	test.setTimeout(180_000);
	await seed("# Typing\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let bo = await join("bo", WIDE);

	let slow = rowOf(main(ana), SLOW.id);
	await slow.hover();
	await slow.getByRole("toolbar", { name: "Reactions and actions" })
		.getByRole("button", { name: "Explain this", exact: true }).click();

	for (let page of [ana, bo]) {
		await expect(replying(main(page), SLOW.id)).toHaveText("chopin is replying…", {
			timeout: 60_000,
		});
		await expect(line(main(page))).toHaveText("");
	}

	let panel = await openThread(bo, SLOW.id);
	await expect(panel.locator('[data-chat-state="working"]')).toHaveCount(1);
	await expect(line(panel)).not.toContainText("chopin");

	await expect(panel.locator(".chat-message-body", { hasText: "Streaming slowly now." }))
		.toBeVisible({ timeout: 60_000 });
	for (let page of [ana, bo]) {
		await expect(replying(main(page), SLOW.id)).toHaveCount(0);
		await expect(rowOf(main(page), SLOW.id).locator("[data-thread-summary]")).toContainText(
			/\d+ repl/,
		);
	}
	await expect(line(panel)).toHaveText("");
});

test("chopin's reaction answer that fails stops showing it replying", async ({ join, seed }) => {
	test.setTimeout(180_000);
	await seed("# Typing\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let bo = await join("bo", WIDE);

	let failing = rowOf(main(ana), FAILING.id);
	await failing.hover();
	await failing.getByRole("toolbar", { name: "Reactions and actions" })
		.getByRole("button", { name: "Explain this", exact: true }).click();

	await expect(replying(main(bo), FAILING.id)).toHaveText("chopin is replying…", {
		timeout: 60_000,
	});
	await expect(replying(main(bo), FAILING.id)).toHaveCount(0, { timeout: 60_000 });
	await expect(replying(main(ana), FAILING.id)).toHaveCount(0);
	await expect(line(main(bo))).toHaveText("");
});

test("someone who can only read sees who is writing in Chat and on a thread's row, and writes nothing", async ({ baseURL, browser, join, room, seed }) => {
	test.setTimeout(120_000);
	await seed("# Typing\nThe cache lives in the router.\n", { transcript: transcript() });
	let ana = await join("ana", WIDE);
	let context = await browser.newContext({ ...WIDE, baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");

		await chatInput(main(ana)).pressSequentially("Thinking");
		await expect(line(main(reader))).toHaveText("@ana is typing…");
		await clear(chatInput(main(ana)));
		await expect(line(main(reader))).toHaveText("");

		let anaPanel = await openThread(ana, ROOT.id);
		await chatInput(anaPanel).pressSequentially("Under the router");
		await expect(replying(main(reader), ROOT.id)).toHaveText("@ana is replying…");
		await expect(line(main(reader))).toHaveText("");
		await expect(replying(main(ana), ROOT.id)).toHaveCount(0);
		await clear(chatInput(anaPanel));
		await expect(replying(main(reader), ROOT.id)).toHaveCount(0);
	} finally {
		await context.close();
	}
});
