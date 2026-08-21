/**
 * The harness proving itself.
 *
 * Everything else in this directory assumes GitHub sign-in opens an authorized
 * channel and leaves an editable plan on screen. If that is not true the rest of
 * the suite fails in six different ways with six different explanations, so it
 * is worth one file that fails in one.
 */

import { content, expect, ready, roomPath, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

async function injectChatHistory(
	page: Page,
	change: (frame: Chat.History) => Chat.History,
) {
	let send: ((frame: Record<string, unknown>) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			try {
				let frame = JSON.parse(message) as { kind?: string };
				route.send(
					frame.kind === "chat:history" ? JSON.stringify(change(frame as Chat.History)) : message,
				);
			} catch {
				route.send(message);
			}
		});
	});

	return { send: (frame: Record<string, unknown>) => send?.(frame) };
}

async function scriptPlanner(page: Page) {
	let started = Promise.withResolvers<void>();
	let send: ((frame: Record<string, unknown>) => void) | undefined;
	let sends: { text: string; to: Chat.Destination }[] = [];
	let turn = 0;
	let busy = false;
	let queued: Chat.Waiting[] = [];
	let active = () => ({
		id: `turn-${++turn}`,
		handle: "ana",
		started: 1_700_000_001,
		responded: false,
	});
	let announce = (id: string, text: string) =>
		send?.({
			kind: "chat:message",
			ts: 0,
			entry: {
				id,
				author: { kind: "member", handle: "ana" },
				text,
				ts: 1_700_000_000,
			},
		});
	let start = () => {
		busy = true;
		send?.({ kind: "chat:state", ts: 0, busy: true, turn: active() });
	};
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => {
			if (typeof message !== "string") return server.send(message);
			try {
				let frame = JSON.parse(message) as {
					kind?: string;
					text?: string;
					to?: Chat.Destination;
				};
				if (frame.kind === "chat:send") {
					sends.push({ text: frame.text ?? "", to: frame.to! });
					if (frame.to === "planner") {
						if (busy) {
							queued = [...queued, {
								id: `queued-${queued.length + 1}`,
								handle: "ana",
								text: frame.text ?? "",
							}];
							send?.({ kind: "chat:queue", ts: 0, waiting: queued });
							return;
						}
						announce("prompt", frame.text ?? "");
						start();
						started.resolve();
						return;
					}
					announce("prompt", frame.text ?? "");
					return;
				}
				if (frame.kind === "chat:abort") {
					let next = queued.shift();
					if (next) {
						send?.({ kind: "chat:queue", ts: 0, waiting: queued });
						announce(next.id, next.text);
						start();
					} else {
						busy = false;
						send?.({ kind: "chat:state", ts: 0, busy: false });
					}
					return;
				}
			} catch {
				// Frames the test does not script still belong to the server.
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});

	return {
		started: started.promise,
		sends: () => sends,
		answer() {
			send?.({
				kind: "chat:message",
				ts: 0,
				entry: {
					id: "answer",
					author: { kind: "agent" },
					text: "The migration is ready.",
					ts: 1_700_000_001,
				},
			});
			busy = false;
			send?.({ kind: "chat:state", ts: 0, busy: false });
		},
		tool() {
			send?.({
				kind: "chat:message",
				ts: 0,
				entry: {
					id: "tools",
					author: { kind: "agent" },
					text: "",
					ts: 1_700_000_001,
				},
			});
			send?.({
				kind: "chat:tool",
				ts: 0,
				entry: "tools",
				activity: { id: "tool-1", name: "read_plan", status: "running" },
			});
		},
		stream() {
			send?.({
				kind: "chat:message",
				ts: 0,
				entry: {
					id: "answer",
					author: { kind: "agent" },
					text: "I found it.",
					ts: 1_700_000_002,
					streaming: true,
				},
			});
		},
		fail() {
			send?.({
				kind: "chat:message",
				ts: 0,
				entry: {
					id: "failure",
					author: { kind: "system" },
					text: "Planner unavailable.",
					ts: 1_700_000_001,
				},
			});
			busy = false;
			send?.({ kind: "chat:state", ts: 0, busy: false });
		},
	};
}

test("a GitHub session joins its authorized channel", async ({ join, room }) => {
	let page = await join("ana");
	let repository = page.getByRole("banner").getByRole("button", {
		name: "Repository: octo-org/score",
	});

	await expect(page).toHaveURL(roomPath(room));
	await expect(repository).toContainText("score");
	await expect(repository).toHaveAttribute("title", "octo-org/score");
	await expect(page.locator("header").first().getByRole("img", { name: "ana" })).toHaveCount(1);
});

test("an unauthenticated visitor is asked to sign in", async ({ page }) => {
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
	await expect(content(page)).toHaveCount(0);
});

test("clicking an empty plan puts the caret at its first writing position", async ({ join }) => {
	let page = await join("ana");
	let editor = content(page);
	let paragraph = editor.locator(":scope > p");

	// The prompt is a sibling overlay. The editable tree needs its own empty
	// block so a click has one stable first writing position.
	await expect(paragraph).toHaveCount(1);
	let paragraphBox = await paragraph.boundingBox();

	expect(paragraphBox).not.toBeNull();
	await page.mouse.click(paragraphBox!.x + 120, paragraphBox!.y + paragraphBox!.height / 2);

	let selection = await editor.evaluate(element => {
		let value = window.getSelection();
		let paragraph = element.querySelector("p")!;

		return {
			anchorIsParagraph: value!.anchorNode === paragraph,
			anchorOffset: value!.anchorOffset,
		};
	});

	expect(selection.anchorIsParagraph).toBe(true);
	expect(selection.anchorOffset).toBe(0);
	await page.keyboard.type("x");
	let text = await editor.evaluate(element => {
		let paragraph = element.querySelector("p")!;
		let range = document.createRange();
		range.selectNodeContents(paragraph);

		return {
			left: range.getBoundingClientRect().left,
			paragraphLeft: paragraph.getBoundingClientRect().left,
		};
	});

	expect(text.left).toBeCloseTo(text.paragraphLeft, 1);
});

test("chat uses one room-message composer when the planner is off", async ({ join }) => {
	let page = await join("ana");
	let chat = page.locator("#pane-chat");
	let composer = chat.locator(".conversation-composer");
	let draft = chat.getByPlaceholder("Message the room — use @ai to ask Planner");
	let send = chat.getByRole("button", { name: "Send message" });

	await expect(chat.locator("header")).toHaveCount(0);
	await expect(draft).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(composer.getByRole("button", { name: "Send message" })).toHaveCount(1);
	await expect(send).toHaveAttribute("title", "Send message");
	await expect(chat.getByRole("button", { name: "Send message" })).toHaveCount(1);
	await expect(chat.getByRole("button", { name: "Send to room" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Ask Planner" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop Planner" })).toHaveCount(0);

	await draft.fill("A room message");
	await expect(send).toBeEnabled();
	await send.click();
	await expect(chat.getByText("A room message")).toBeVisible();

	await draft.fill("@ai Do not start a turn here.");
	await send.click();
	await expect(chat.locator(".chat-working")).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop Planner" })).toHaveCount(0);
});

test("chat disables Send when its socket disconnects", async ({ join, page }) => {
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		route.connectToServer();
		sockets.push(route);
	});

	let chat = (await join("ana")).locator("#pane-chat");
	let draft = chat.getByPlaceholder("Message the room — use @ai to ask Planner");
	let send = chat.getByRole("button", { name: "Send message" });
	await draft.fill("A draft left during reconnect.");
	await expect(send).toBeEnabled();

	await sockets.at(-1)!.close();
	await expect(send).toBeDisabled();
});

test("chat routes one Send action by @ai without blocking room messages or its queue", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = (await join("ana")).locator("#pane-chat");
	let composer = chat.locator(".conversation-composer");
	let draft = chat.getByPlaceholder("Message the room — use @ai to ask Planner");
	let send = chat.getByRole("button", { name: "Send message" });

	await draft.fill("@ai Start the migration.");
	await draft.press("Enter");
	await planner.started;
	await expect(composer.getByRole("button", { name: "Stop Planner" })).toBeVisible();
	await expect(chat.getByRole("button", { name: "Stop Planner" })).toHaveAttribute(
		"title",
		"Stop Planner",
	);

	await draft.fill("Keep the release notes brief.");
	await expect(send).toBeEnabled();
	await send.click();
	await draft.fill("@ai Queue the rollback checks.");
	await send.click();
	await expect.poll(planner.sends).toEqual([
		{ text: "@ai Start the migration.", to: "planner" },
		{ text: "Keep the release notes brief.", to: "room" },
		{ text: "@ai Queue the rollback checks.", to: "planner" },
	]);
	await expect(chat.getByText("queued", { exact: true })).toBeVisible();

	await draft.fill("@ai Keep\nthe new line.");
	await draft.press("Shift+Enter");
	await expect(draft).toHaveValue("@ai Keep\nthe new line.\n");
	await draft.press("Enter");
	await expect.poll(planner.sends).toContainEqual({
		text: "@ai Keep\nthe new line.",
		to: "planner",
	});

	await chat.getByRole("button", { name: "Stop Planner" }).click();
	await expect(chat.locator(".chat-working")).toBeVisible();
	let next = chat.locator("[data-chat-entry]").filter({ hasText: "Queue the rollback checks." });
	let later = chat.locator("[data-chat-entry]").filter({ hasText: /Keep\s+the new line/ });
	await expect(next).toHaveCount(1);
	await expect(next).not.toContainText("queued");
	await expect(later).toHaveCount(1);
	await expect(later).toContainText("queued");
});

test("chat replaces the Planner working row with its response", async ({ join, page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let planner = await scriptPlanner(page);
	let chat = (await join("ana")).locator("#pane-chat");

	await chat.getByPlaceholder("Message the room — use @ai to ask Planner").fill(
		"@ai Draft the migration.",
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;

	let working = chat.locator(".chat-working");
	await expect(working).toHaveText("Working on it");
	let timestamp = await page.evaluate(() =>
		new Date(1_700_000_001 * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	);
	await expect(
		working.locator("xpath=ancestor::*[@data-chat-entry][1]").getByText(timestamp, { exact: true }),
	).toBeVisible();
	await expect(chat.getByText("Invalid Date")).toHaveCount(0);
	await expect(working).toHaveCSS("animation-name", "chat-working-shimmer");
	let avatar = chat.getByRole("img", { name: "Planner" });
	expect(await avatar.evaluate(element => getComputedStyle(element).animationName)).toBe("none");

	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(working).toHaveCSS("animation-name", "none");

	planner.answer();
	await expect(working).toHaveCount(0);
	await expect(chat.getByText("The migration is ready.")).toBeVisible();
	await expect(chat.locator("[data-chat-entry]")).toHaveCount(2);
});

test("chat clears the Planner working row when a turn stops or fails", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = (await join("ana")).locator("#pane-chat");

	await chat.getByPlaceholder("Message the room — use @ai to ask Planner").fill(
		"@ai Draft the migration.",
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;
	await expect(chat.locator(".chat-working")).toBeVisible();

	await chat.getByRole("button", { name: "Stop Planner" }).click();
	await expect(chat.locator(".chat-working")).toHaveCount(0);

	await chat.getByPlaceholder("Message the room — use @ai to ask Planner").fill("@ai Try again.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect(chat.locator(".chat-working")).toBeVisible();
	planner.fail();
	await expect(chat.locator(".chat-working")).toHaveCount(0);
	await expect(chat.getByText("Planner unavailable.")).toBeVisible();

	await page.reload();
	await ready(page);
	await expect(page.locator("#pane-chat .chat-working")).toHaveCount(0);
});

test("chat keeps Working on it through tool activity and streamed prose", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = (await join("ana")).locator("#pane-chat");

	await chat.getByPlaceholder("Message the room — use @ai to ask Planner").fill(
		"@ai Check the current plan.",
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;
	await expect(chat.locator(".chat-working")).toBeVisible();

	planner.tool();
	await expect(chat.getByText("Read plan", { exact: true })).toBeVisible();
	await expect(chat.locator(".chat-working")).toBeVisible();

	planner.stream();
	await expect(chat.locator(".chat-working")).toBeVisible();
	await expect(chat.getByText("I found it.")).toBeVisible();

	await chat.getByRole("button", { name: "Stop Planner" }).click();
	await expect(chat.locator(".chat-working")).toHaveCount(0);
});

test("chat history keeps Working on it after Planner prose and a later room message", async ({ join, page }) => {
	await injectChatHistory(page, frame => ({
		...frame,
		busy: true,
		turn: { id: "turn-1", handle: "ana", started: 1_700_000_000, responded: true },
		entries: [
			{
				id: "prompt",
				author: { kind: "member", handle: "ana" },
				text: "@ai Check the current plan.",
				ts: 1_700_000_000,
			},
			{
				id: "answer",
				author: { kind: "agent" },
				text: "I found the issue.",
				ts: 1_700_000_001,
			},
			{
				id: "room",
				author: { kind: "member", handle: "sam" },
				text: "Please include the examples.",
				ts: 1_700_000_002,
			},
		],
	}));

	let chat = (await join("ana")).locator("#pane-chat");
	await expect(chat.getByText("I found the issue.")).toBeVisible();
	await expect(chat.getByText("Please include the examples.")).toBeVisible();
	await expect(chat.locator(".chat-working")).toBeVisible();
});

test("chat waits for fresh history after reconnect before projecting a stale turn", async ({ join, page }) => {
	let sockets: WebSocketRoute[] = [];
	let historyHeld = Promise.withResolvers<void>();
	let releaseHistory: (() => void) | undefined;

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		sockets.push(route);
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind?: string };
			if (sockets.length === 2 && frame.kind === "chat:history") {
				route.send(JSON.stringify({
					kind: "chat:state",
					ts: 0,
					busy: true,
					turn: { id: "stale", handle: "ana", started: 1_700_000_000, responded: false },
				}));
				releaseHistory = () => route.send(message);
				historyHeld.resolve();
				return;
			}
			route.send(message);
		});
	});

	let chat = (await join("ana")).locator("#pane-chat");
	await expect(chat.locator(".chat-working")).toHaveCount(0);
	await sockets[0]!.close();
	await historyHeld.promise;
	await expect(chat.locator(".chat-working")).toHaveCount(0);

	releaseHistory?.();
	await ready(page);
	await expect(chat.locator(".chat-working")).toHaveCount(0);
});

test(
	"chat keeps a running turn and its queue readable together",
	async ({ join, page }, testInfo) => {
		await injectChatHistory(page, frame => ({
			...frame,
			busy: true,
			entries: [
				{
					id: "m1",
					author: { kind: "member", handle: "maggie" },
					text: "@ai Draft the migration plan.",
					ts: 1_700_000_000,
				},
				{
					id: "a1",
					author: { kind: "agent" },
					text: "I’m checking the implementation before I edit.",
					ts: 1_700_000_001,
					streaming: true,
					tools: [
						...Array.from({ length: 7 }, (_, index) => ({
							id: `t${index}`,
							name: "read_file",
							status: "done" as const,
							took: 20,
						})),
						{ id: "t7", name: "edit_plan", status: "running" },
					],
				},
			],
			queued: [
				{ id: "q1", handle: "ana", text: "@ai" },
				{ id: "q2", handle: "sam", text: "Check the rollback path too." },
			],
		}));

		await join("ana");
		let chat = page.locator("#pane-chat");
		let live = chat.getByText("Edit plan", { exact: true }).locator("..");

		await expect(live).toContainText("7 done");
		expect((await live.boundingBox())?.height).toBe(28);
		await expect(chat.getByRole("button", { name: /Edit plan/ })).toHaveCount(0);
		await expect(chat.getByRole("button", { name: "Stop Planner" })).toHaveCount(0);
		let person = chat.getByRole("img", { name: "maggie" });
		let planner = chat.getByRole("img", { name: "Planner" });
		expect((await person.boundingBox())?.width).toBe(20);
		expect((await person.boundingBox())?.height).toBe(20);
		expect((await planner.boundingBox())?.width).toBe(20);
		expect((await planner.boundingBox())?.height).toBe(20);
		expect(await person.evaluate(element => getComputedStyle(element).borderRadius)).not.toBe(
			await planner.evaluate(element => getComputedStyle(element).borderRadius),
		);

		let mine = chat.locator("[data-chat-entry]").filter({ hasText: "Ask Planner" });
		let theirs = chat.locator("[data-chat-entry]").filter({
			hasText: "Check the rollback path too.",
		});
		await expect(mine).toContainText("queued");
		await expect(mine.getByRole("button", { name: "Withdraw queued message" })).toBeVisible();
		await expect(theirs.getByRole("button", { name: "Withdraw queued message" })).toHaveCount(0);

		await testInfo.attach("running-turn-with-queue", {
			body: await chat.screenshot(),
			contentType: "image/png",
		});
	},
);

test(
	"chat groups authors and collapses a finished tool run",
	async ({ join, seed }, testInfo) => {
		await seed("# Migration\n", {
			transcript: [
				{
					id: "m1",
					author: { kind: "member", handle: "maggie" },
					text: "@ai Can you draft the migration?",
					ts: 1_700_000_000,
				},
				{
					id: "m2",
					author: { kind: "member", handle: "maggie" },
					text: "Focus on rollback.",
					ts: 1_700_000_001,
				},
				{
					id: "a1",
					author: { kind: "agent" },
					text: "Drafted it.",
					ts: 1_700_000_002,
					tools: [
						{ id: "t1", name: "read_file", status: "done", took: 38 },
						{ id: "t2", name: "grep", status: "done", took: 12 },
						{ id: "t3", name: "edit_plan", status: "done", took: 1_200 },
						{ id: "t4", name: "run_tests", status: "failed" },
					],
				},
				{
					id: "s1",
					author: { kind: "system" },
					text: "@sam joined",
					ts: 1_700_000_003,
				},
			],
		});

		let page = await join("ana");
		let chat = page.locator("#pane-chat");

		await expect(chat.getByText("Maggie", { exact: true })).toHaveCount(1);
		await expect(chat).toContainText("Can you draft the migration?");
		await expect(chat).not.toContainText("@");
		await expect(chat.getByText("Read file", { exact: true })).toHaveCount(0);

		let run = chat.getByRole("button", { name: /4 tools.*1 failed.*1\.3s/ });
		await expect(run).toBeVisible();
		expect(
			await run.evaluate(element => ({
				background: getComputedStyle(element).backgroundColor,
				border: getComputedStyle(element).borderTopWidth,
				height: getComputedStyle(element).height,
			})),
		).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", height: "28px" });
		await expect(run.getByText("1 failed")).toHaveClass(/text-destructive-ink/);
		await run.click();
		await expect(chat.getByText("Read file", { exact: true })).toBeVisible();
		await expect(chat.getByText("Run tests", { exact: true })).toBeVisible();
		let failed = chat.getByRole("listitem").filter({ hasText: "Run tests" });
		await expect(failed).toContainText("Failed");
		await expect(failed.getByText("Failed", { exact: true })).toHaveClass(/text-destructive-ink/);
		let firstTool = chat.getByRole("list", { name: "Tool calls" }).getByRole("listitem").first();
		expect((await firstTool.getByText("Read file").boundingBox())!.x).toBeLessThan(
			(await firstTool.getByText("38ms").boundingBox())!.x,
		);

		let system = chat.locator("[data-chat-system]");
		await expect(system).toContainText("Sam joined");
		expect(await system.evaluate(element => getComputedStyle(element).fontStyle)).toBe("normal");
		expect(await system.locator("p").evaluate(element => getComputedStyle(element).fontSize)).toBe(
			"13px",
		);

		await testInfo.attach("finished-turn-with-failure-open", {
			body: await chat.screenshot(),
			contentType: "image/png",
		});
	},
);

test("an empty room settles rather than loading forever", async ({ join }) => {
	let page = await join("ana");

	// "Ready" is the resting state and it draws nothing, so the assertion is
	// on the label the status pane keeps for a screen reader either way.
	await expect(page.locator(".plan-status")).toContainText("Ready");
	await expect(page.locator(".plan-status")).toHaveAttribute("data-level", "hidden");
});
