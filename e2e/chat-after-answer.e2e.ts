/**
 * After chopin's answer is out, Chat shows nothing more of the turn unless chopin does more: the
 * check that runs after a reply, and a background job such as keeping the title, are quiet turns.
 * They draw no working row and offer no Stop, unless a message was refused because of one. A repair
 * step the check starts is work again. A scripted Planner holds each state for as long as a test
 * looks at it.
 */

import { chatInput, fillChat } from "./chat-input";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

const BUSY = "chopin can't take messages while it works on this machine. Stop it to ask now.";

async function scriptPlanner(page: Page) {
	let routes: { send: (frame: Record<string, unknown>) => void }[] = [];
	let entries = 0;
	let turns = 0;
	let refuse = false;
	let tell = (frame: Record<string, unknown>) => routes.at(-1)?.send(frame);
	let turn = (extra: Partial<Chat.Turn> = {}): Chat.Turn => ({
		id: `turn-${turns}`,
		handle: "ana",
		started: 1_700_000_001,
		entryOffset: entries,
		responded: false,
		...extra,
	});
	let state = (busy: boolean, current?: Chat.Turn) =>
		tell({ kind: "chat:state", ts: 0, busy, ...(current ? { turn: current } : {}) });
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({
			response,
			json: { ...await response.json() as Record<string, unknown>, agent: true },
		});
	});
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		routes.push({ send: frame => route.send(JSON.stringify(frame)) });
		route.onMessage(message => {
			if (typeof message !== "string") return server.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				rid?: string;
				text?: string;
				to?: string;
			};
			if (frame.kind === "chat:send") {
				if (refuse) {
					return tell({
						kind: "session:error",
						ts: 0,
						rid: frame.rid,
						code: "planner-busy",
						message: BUSY,
					});
				}
				let id = `sent-${entries}`;
				tell({ kind: "chat:send", ts: 0, rid: frame.rid, id });
				tell({
					kind: "chat:message",
					ts: 0,
					entry: {
						id,
						author: { kind: "member", handle: "ana" },
						text: frame.text ?? "",
						ts: 1_700_000_000,
						to: frame.to,
					},
				});
				entries++;
				turns++;
				return state(true, turn());
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let current: Chat.Turn | undefined;
	return {
		/** The answer is all out: the turn now only checks it. */
		answer(text = "An iterator yields one item at a time.") {
			current = turn({ entryOffset: entries, responded: true });
			tell({
				kind: "chat:message",
				ts: 0,
				entry: { id: `answer-${turns}`, author: { kind: "agent" }, text, ts: 1_700_000_002 },
			});
			entries++;
			state(true, { ...current, entryOffset: current.entryOffset });
		},
		quiet() {
			state(true, { ...current!, quiet: true });
		},
		/** The check found a question asked in Chat: the repair step is work again. */
		repair() {
			state(true, { ...current! });
		},
		end() {
			state(false);
		},
		/** A background job's turn, after the answer. */
		job() {
			turns++;
			state(true, turn({ quiet: true }));
		},
		refuse() {
			refuse = true;
		},
	};
}

async function ask(chat: Locator, text = "@chopin What is an iterator?") {
	let draft = chatInput(chat);
	await fillChat(draft, text);
	await draft.press("Enter");
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();
}

function answer(chat: Locator) {
	return chat.locator("[data-chat-message-id^='answer-']");
}

test("once the answer is out, its check shows nothing: no working row, no Stop, no start time", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await ask(chat);
	planner.answer();
	await expect(answer(chat)).toHaveCount(1);
	// While the turn works on, the answer says so, and Stop is there.
	await expect(chat.locator(".chat-work[data-work-active='true']")).toHaveCount(1);

	planner.quiet();
	await expect(chat.locator(".chat-work")).toHaveCount(0);
	await expect(chat.getByText("Getting oriented")).toHaveCount(0);
	await expect(chat.getByText("Reviewing the next step")).toHaveCount(0);
	await expect(chat.getByText(/^Started at/)).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	await expect(chat.locator("[data-send-stop]")).toHaveAttribute("data-send-stop", "send");

	planner.end();
	await expect(answer(chat)).toHaveCount(1);
	await expect(chat.locator(".chat-work")).toHaveCount(0);
});

test("a repair step the check starts is work again, shown in place on the answer", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await ask(chat);
	planner.answer("Which scope do you want?");
	planner.quiet();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);

	planner.repair();
	await expect(chat.locator(".chat-work[data-work-active='true']")).toHaveCount(1);
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();
	// In place: still one chopin answer, and no second row for the repair.
	await expect(answer(chat)).toHaveCount(1);
	planner.end();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
});

test("a background job after the answer draws no row and no Stop, until a message is refused because of it", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await ask(chat);
	planner.answer();
	planner.end();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);

	planner.job();
	// Nothing new appears under the answer, and nothing offers to stop.
	await page.waitForTimeout(300);
	await expect(chat.getByText("Getting oriented")).toHaveCount(0);
	await expect(chat.locator(".chat-work")).toHaveCount(0);
	await expect(chat.getByText(/^Started at/)).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);

	// A message the job refuses brings Stop, so it can be stopped to ask now.
	planner.refuse();
	let draft = chatInput(chat);
	await fillChat(draft, "@chopin And a Rust iterator adapter?");
	await draft.press("Enter");
	await expect(chat.getByText(BUSY)).toBeVisible();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();
});

test("on a phone, the Chat tab says chopin is working only while it is, not through a background job", async ({ join, page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let planner = await scriptPlanner(page);
	let joined = await join("ana");
	let tab = joined.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	await tab.click();
	let chat = chatPane(joined);
	await ask(chat);
	await expect(tab).toHaveAccessibleName(/chopin working/);
	planner.answer();
	planner.quiet();
	await expect(tab).not.toHaveAccessibleName(/working/);
	await expect(joined.locator(".workspace-working-indicator")).toHaveCount(0);
	planner.end();
	planner.job();
	await page.waitForTimeout(300);
	await expect(tab).not.toHaveAccessibleName(/working/);
	await expect(joined.locator(".workspace-working-indicator")).toHaveCount(0);
});
