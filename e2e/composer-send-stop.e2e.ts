/**
 * The composer's one round button, assistant-ui's own: send while the Planner is idle, stop while it
 * runs and the draft is empty, and send (to queue) while it runs and the draft has words. A scripted
 * Planner stands in for the harness, so each state is held as long as a test needs to look at it.
 */

import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { expect, openIsolatedRoom, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { BrowserContext, Locator, Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/** The round button, under whichever name it has now. */
function button(chat: Locator) {
	return chat.locator('[data-slot="composer-send"]');
}

/** Which icon the button is showing: the arrow or the square, whichever is not faded out. */
function icon(chat: Locator) {
	return button(chat).evaluate(element =>
		[...element.querySelectorAll("svg")]
			.filter(svg => getComputedStyle(svg).opacity === "1")
			.map(svg => svg.classList.contains("lucide-square") ? "square" : "arrow")
	);
}

/** The Planner, scripted: busy from the first message to the Planner until `answer` or a Stop. */
async function scriptPlanner(target: Page | BrowserContext) {
	let routes: { send: (frame: Record<string, unknown>) => void; close: () => void }[] = [];
	let hello: Record<string, unknown> | undefined;
	let sends: { text: string; to: Chat.Destination }[] = [];
	let aborts = 0;
	let offline = false;
	let busy = false;
	let queued: Chat.Waiting[] = [];
	let turn = 0;
	let entries = 0;
	let streaming = false;
	let tell = (frame: Record<string, unknown>) => routes.at(-1)?.send(frame);
	let announce = (id: string, text: string) => {
		entries++;
		tell({
			kind: "chat:message",
			ts: 0,
			entry: { id, author: { kind: "member", handle: "ana" }, text, ts: 1_700_000_000 },
		});
	};
	let begin = () => {
		busy = true;
		tell({
			kind: "chat:state",
			ts: 0,
			busy: true,
			turn: {
				id: `turn-${++turn}`,
				handle: "ana",
				started: 1_700_000_001,
				entryOffset: entries,
				responded: false,
			},
		});
	};
	let finish = () => {
		busy = false;
		tell({ kind: "chat:state", ts: 0, busy: false });
	};
	await target.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({
			response,
			json: { ...await response.json() as Record<string, unknown>, agent: true },
		});
	});
	await target.routeWebSocket("**/ws?**", route => {
		if (offline) return void route.close();
		let server = route.connectToServer();
		routes.push({ send: frame => route.send(JSON.stringify(frame)), close: () => route.close() });
		route.onMessage(message => {
			if (typeof message !== "string") return server.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				rid?: string;
				text?: string;
				to?: Chat.Destination;
			};
			if (frame.kind === "chat:send") {
				sends.push({ text: frame.text ?? "", to: frame.to! });
				let id = `accepted-${sends.length}`;
				let waiting = frame.to === "planner" && busy;
				tell({ kind: "chat:send", ts: 0, rid: frame.rid, id, queued: waiting });
				if (frame.to !== "planner") return announce(id, frame.text ?? "");
				if (busy) {
					queued = [...queued, { id, handle: "ana", text: frame.text ?? "" }];
					return tell({ kind: "chat:queue", ts: 0, waiting: queued });
				}
				announce(id, frame.text ?? "");
				return begin();
			}
			if (frame.kind === "chat:abort") {
				aborts++;
				let next = queued.shift();
				if (!next) return finish();
				tell({ kind: "chat:queue", ts: 0, waiting: queued });
				announce(next.id, next.text);
				return begin();
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as Record<string, unknown>;
					if (frame.kind === "session:hello") hello = frame;
				} catch {
					// Not a frame the script reads.
				}
			}
			route.send(message);
		});
	});
	return {
		sends: () => sends,
		aborts: () => aborts,
		/** One token of the reply: the button must not announce it. */
		token(text: string) {
			if (!streaming) {
				streaming = true;
				tell({
					kind: "chat:message",
					ts: 0,
					entry: {
						id: "answer",
						author: { kind: "agent" },
						text: "",
						ts: 1_700_000_002,
						streaming: true,
					},
				});
			}
			tell({ kind: "chat:delta", ts: 0, id: "answer", text });
		},
		answer() {
			tell({
				kind: "chat:message",
				ts: 0,
				entry: { id: "answer", author: { kind: "agent" }, text: "Done.", ts: 1_700_000_003 },
			});
			finish();
		},
		/** The person's write access goes while the Planner runs. */
		revokeWrite() {
			tell({ ...hello, canEdit: false, canManage: false });
		},
		/** The socket drops and does not come back. */
		disconnect() {
			offline = true;
			for (let route of routes) route.close();
		},
	};
}

async function startPlanner(chat: Locator, text = "@chopin Start the migration."): Promise<void> {
	let draft = chatInput(chat);
	await fillChat(draft, text);
	await draft.press("Enter");
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();
}

test("an idle composer sends: the round button waits for a draft, and it and Enter both send", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });

	await expect(send).toBeDisabled();
	await expect(send).toHaveAttribute("title", "Send message");
	expect(await send.evaluate(element => getComputedStyle(element).opacity)).toBe("0.3");
	await expect.poll(() => icon(chat)).toEqual(["arrow"]);

	await draft.fill("A note for the team");
	await expect(send).toBeEnabled();
	// Fully drawn once its fade has run.
	await expect.poll(() => send.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
	await send.click();
	await expect.poll(planner.sends).toEqual([{ text: "A note for the team", to: "room" }]);
	await expect(send).toBeDisabled();

	await draft.fill("Another, by keyboard");
	await draft.press("Enter");
	await expect.poll(planner.sends).toHaveLength(2);
	await expectChatValue(draft, "");
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
});

test("a running Planner with nothing typed is stopped by the same button, which is then a send again", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await startPlanner(chat);

	let stop = chat.getByRole("button", { name: "Stop generating" });
	await expect(stop).toBeEnabled();
	await expect(stop).toHaveAttribute("title", "Stop generating");
	await expect(chat.getByRole("button", { name: "Send message" })).toHaveCount(0);
	await expect.poll(() => icon(chat)).toEqual(["square"]);
	await expect.poll(() => stop.evaluate(element => getComputedStyle(element).opacity)).toBe("1");

	await stop.click();
	await expect.poll(planner.aborts).toBe(1);
	let send = chat.getByRole("button", { name: "Send message" });
	await expect(send).toBeDisabled();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	await expect.poll(() => icon(chat)).toEqual(["arrow"]);
});

test("a message typed while the Planner runs is queued by the button as by Enter, and the button is a stop again once the draft is gone", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await startPlanner(chat);

	// Words in the draft turn it into a send that queues.
	await fillChat(draft, "@chopin Queue the rollback checks.");
	let send = chat.getByRole("button", { name: "Send message" });
	await expect(send).toBeEnabled();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	await expect.poll(() => icon(chat)).toEqual(["arrow"]);
	await send.click();
	await expect.poll(planner.sends).toContainEqual({
		text: "@chopin Queue the rollback checks.",
		to: "planner",
	});
	await expect(chat.getByRole("button", { name: "Withdraw queued message" })).toHaveCount(1);
	// Sent: the draft is empty and the Planner still runs, so it is a stop again.
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();
	await expect.poll(() => icon(chat)).toEqual(["square"]);

	// Cleared, not sent: the same.
	await fillChat(draft, "Never mind");
	await expect(chat.getByRole("button", { name: "Send message" })).toBeEnabled();
	await draft.fill("");
	await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible();

	// Enter queues exactly as the button does.
	await fillChat(draft, "@chopin And the release notes.");
	await draft.press("Enter");
	await expect.poll(planner.sends).toContainEqual({
		text: "@chopin And the release notes.",
		to: "planner",
	});
	await expect(chat.getByRole("button", { name: "Withdraw queued message" })).toHaveCount(2);
	expect(planner.aborts()).toBe(0);
});

test("the button is reached and pressed from the keyboard, whichever it is", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await fillChat(draft, "A note for the team");
	let send = chat.getByRole("button", { name: "Send message" });
	await send.focus();
	await page.keyboard.press("Enter");
	await expect.poll(planner.sends).toHaveLength(1);

	await startPlanner(chat);
	let stop = chat.getByRole("button", { name: "Stop generating" });
	await stop.focus();
	await expect(stop).toBeFocused();
	await page.keyboard.press("Space");
	await expect.poll(planner.aborts).toBe(1);
});

test("someone who may not stop the Planner is never shown a stop: write access taken away, and a connection that is gone", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await startPlanner(chat);

	// A connection that outlasts a blip: the page says so, Stop is not offered, a disabled send is.
	planner.disconnect();
	let send = chat.getByRole("button", { name: "Send message" });
	await expect(send).toBeDisabled();
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	await expect.poll(() => icon(chat)).toEqual(["arrow"]);
	expect(planner.aborts()).toBe(0);
});

test("a viewer whose write access goes while the Planner runs has no button at all, not a stop", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await startPlanner(chat);

	planner.revokeWrite();
	await expect(chat.getByText("You have read-only access to this document.", { exact: true }))
		.toBeVisible();
	await expect(button(chat)).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Send message" })).toHaveCount(0);
});

test("a polite live region says once that the button became a stop, not for each token, and once that it is a send again", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	let region = chat.locator("[data-send-stop-status]");
	await expect(region).toHaveAttribute("aria-live", "polite");
	await expect(region).toHaveText("");
	await region.evaluate(element => {
		let heard: string[] = [];
		(window as unknown as { heard: string[] }).heard = heard;
		new MutationObserver(records => {
			for (let record of records) {
				for (let node of record.addedNodes) if (node.textContent) heard.push(node.textContent);
			}
		}).observe(element, { childList: true, subtree: true });
	});
	let heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard);

	// Typing a message to the team changes the button's state, not its action: nothing is said.
	await chatInput(chat).fill("A note");
	await expect(chat.getByRole("button", { name: "Send message" })).toBeEnabled();
	expect(await heard()).toEqual([]);

	await chatInput(chat).fill("");
	await startPlanner(chat);
	await expect(region).toHaveText("Stop generating");
	for (let index = 0; index < 20; index++) planner.token(` word${index}`);
	await expect(chat.getByText("word19")).toBeVisible();
	expect(await heard()).toEqual(["Stop generating"]);

	planner.answer();
	await expect(region).toHaveText("Send message");
	await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled();
	expect(await heard()).toEqual(["Stop generating", "Send message"]);
});

test("under reduced motion the icons swap at once, and without it they animate", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let chat = chatPane(await join("ana"));
	await button(chat).evaluate(element => {
		let runs = { count: 0 };
		(window as unknown as { runs: typeof runs }).runs = runs;
		// The swap is the icons' motion; the button's own colour fade is not.
		element.addEventListener("transitionrun", event => {
			if (event.target instanceof SVGElement) runs.count++;
		});
	});
	let transitions = () =>
		page.evaluate(() => (window as unknown as { runs: { count: number } }).runs.count);
	await startPlanner(chat);
	await expect.poll(transitions).toBeGreaterThan(0);
	let moving = await button(chat).evaluate(element =>
		getComputedStyle(element.querySelector("svg")!).transitionProperty
	);
	expect(moving).toContain("opacity");

	await page.emulateMedia({ reducedMotion: "reduce" });
	let before = await transitions();
	planner.answer();
	await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect.poll(() => icon(chat)).toEqual(["arrow"]);
	expect(await transitions()).toBe(before);
	let still = await button(chat).evaluate(element =>
		[...element.querySelectorAll("svg")].map(svg => getComputedStyle(svg).transitionProperty)
	);
	expect(still).toEqual(["none", "none"]);
});

test("on a phone the button is the same 32px circle with a 44px target, and is a stop while the Planner runs", async ({ baseURL, browser, room }) => {
	let planner: Awaited<ReturnType<typeof scriptPlanner>> | undefined;
	let emulation = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"ana",
		{ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
		async context => {
			planner = await scriptPlanner(context);
		},
	);
	try {
		let page = emulation.page;
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		let chat = chatPane(page);
		await expect(chatInput(chat)).toBeVisible();
		await expect.poll(async () => (await chat.boundingBox())?.x).toBe(0);
		let aim = (offset: number) =>
			button(chat).evaluate((element, by) => {
				let box = element.getBoundingClientRect();
				let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height + by);
				return hit?.closest("button") === element;
			}, offset);

		let send = chat.getByRole("button", { name: "Send message" });
		await expect(send).toBeDisabled();
		let box = (await send.boundingBox())!;
		expect([box.width, box.height]).toEqual([32, 32]);
		await startPlanner(chat);
		let stop = chat.getByRole("button", { name: "Stop generating" });
		expect((await stop.boundingBox())!.width).toBe(32);
		// The 44px target reaches 6px past the 32px circle: a finger 5px below still lands on it.
		expect(await aim(5)).toBe(true);
		expect(await aim(8)).toBe(false);
		await stop.tap();
		await expect.poll(() => planner!.aborts()).toBe(1);
		await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled();
	} finally {
		await emulation.close();
	}
});
