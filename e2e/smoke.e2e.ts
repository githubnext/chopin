import { chatInput, expectChatValue, fillChat } from "./chat-input";
/**
 * The harness proving itself.
 *
 * Everything else in this directory assumes GitHub sign-in opens an authorized
 * channel and leaves an editable plan on screen. If that is not true the rest of
 * the suite fails in six different ways with six different explanations, so it
 * is worth one file that fails in one.
 */

import { content, expect, ready, roomPath, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";

import type { Chat } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

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
	let toolCount = 0;
	let toolEntry = "";
	let toolEntrySent = false;
	let toolNames = new Map<string, string>();
	let toolEntries = new Map<string, string>();
	let sentEntryIds = new Set<string>();
	let active = () => ({
		id: `turn-${++turn}`,
		handle: "ana",
		started: 1_700_000_001,
		entryOffset: sentEntryIds.size,
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
		let state = active();
		toolEntry = `tools-${turn}`;
		toolEntrySent = false;
		send?.({ kind: "chat:state", ts: 0, busy: true, turn: state });
	};
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => {
			let entry = frame.entry as { id?: string } | undefined;
			if (frame.kind === "chat:message" && entry?.id) sentEntryIds.add(entry.id);
			route.send(JSON.stringify(frame));
		};
		route.onMessage(message => {
			if (typeof message !== "string") return server.send(message);
			try {
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
					send?.({ kind: "chat:send", ts: 0, rid: frame.rid, id, queued: waiting });
					if (frame.to === "planner") {
						if (busy) {
							queued = [...queued, {
								id,
								handle: "ana",
								text: frame.text ?? "",
							}];
							send?.({ kind: "chat:queue", ts: 0, waiting: queued });
							return;
						}
						announce(id, frame.text ?? "");
						start();
						started.resolve();
						return;
					}
					announce(id, frame.text ?? "");
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
		tool(name = "read_plan", args = '{ "path": "src/store.ts" }', separateEntry = false) {
			if (separateEntry) {
				toolEntry = `tools-${turn}-${toolCount + 1}`;
				toolEntrySent = false;
			}
			if (!toolEntrySent) {
				send?.({
					kind: "chat:message",
					ts: 0,
					entry: {
						id: toolEntry,
						author: { kind: "agent" },
						text: "",
						ts: 1_700_000_001,
					},
				});
				toolEntrySent = true;
			}
			let id = `tool-${++toolCount}`;
			toolNames.set(id, name);
			toolEntries.set(id, toolEntry);
			send?.({
				kind: "chat:tool",
				ts: 0,
				entry: toolEntry,
				activity: { id, name, status: "running", args },
			});
			return id;
		},
		finishTool(id: string, status: "done" | "failed", result: string) {
			send?.({
				kind: "chat:tool",
				ts: 0,
				entry: toolEntries.get(id),
				activity: { id, name: toolNames.get(id), status, result, took: 38 },
			});
		},
		complete() {
			send?.({
				kind: "chat:message",
				ts: 0,
				entry: {
					id: "answer",
					author: { kind: "agent" },
					text: "I found it.",
					ts: 1_700_000_002,
				},
			});
			busy = false;
			send?.({ kind: "chat:state", ts: 0, busy: false });
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
	let projects = page.getByRole("complementary", { name: "Projects" });
	let repository = projects.getByRole("button", { name: "score", exact: true });

	await expect(page).toHaveURL(roomPath(room));
	await expect(repository).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("banner").getByRole("img", { name: "ana" })).toHaveCount(1);
});

test("an unauthenticated visitor is asked to sign in", async ({ page }) => {
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
	await expect(content(page)).toHaveCount(0);
});

test("an empty plan puts its muted prompt at the first writing position", async ({ join }) => {
	let page = await join("ana");
	await page.setViewportSize({ width: 1800, height: 900 });
	let editor = content(page);
	let paragraph = editor.locator(":scope > p");
	let prompt = page.getByText("Start writing, or ask Chopin to plan", { exact: true });

	// The prompt is a sibling overlay. The editable tree needs its own empty
	// block, and the two must share one stable first writing position.
	await expect(paragraph).toHaveCount(1);
	// Read both positions in one frame: separate calls can straddle the resize layout.
	await expect.poll(() =>
		editor.evaluate(element => {
			let paragraph = element.querySelector("p")!;
			let placeholder = element.closest(".mdxeditor-root-contenteditable")!
				.querySelector(":scope > .plan-content p")!;
			return Math.abs(
				paragraph.getBoundingClientRect().x - placeholder.getBoundingClientRect().x,
			);
		})
	).toBeLessThan(0.05);
	let paragraphBox = await paragraph.boundingBox();
	let colors = await prompt.evaluate(element => {
		let reference = document.createElement("span");
		reference.style.color = "var(--color-text-quaternary)";
		document.body.append(reference);
		let muted = getComputedStyle(reference).color;
		reference.remove();

		return { actual: getComputedStyle(element).color, muted };
	});

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
	expect(colors.actual).toBe(colors.muted);
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
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });

	await expect(chat.locator("header")).toHaveCount(0);
	await expect(draft).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(chat.getByRole("button", { name: "Send message" })).toHaveCount(1);
	await expect(send).toHaveAttribute("title", "Send message");
	await expect(chat.getByRole("button", { name: "Send message" })).toHaveCount(1);
	await expect(chat.getByRole("button", { name: "Send to room" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Ask Chopin" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop Chopin" })).toHaveCount(0);

	await draft.fill("A room message");
	await expect(send).toBeEnabled();
	await send.click();
	await expect(chat.getByText("A room message")).toBeVisible();

	await draft.fill("@chopin Do not start a turn here.");
	await send.click();
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Stop Chopin" })).toHaveCount(0);
});

test("chat keeps both ends of a tall transcript clear across layouts", async ({ join, page }) => {
	await injectChatHistory(page, frame => ({
		...frame,
		entries: Array.from({ length: 24 }, (_, index) => ({
			author: index % 2 === 0
				? { kind: "member" as const, handle: "ana" }
				: { kind: "agent" as const },
			id: `history-${index}`,
			text: index === 0
				? "The first message in a deliberately tall transcript."
				: `Transcript message ${index} with enough text to occupy a complete line.`,
			ts: 1_700_000_000 + index,
		})),
	}));

	let chat = chatPane(await join("ana"));
	let stack = chat.locator("[data-chat-stack]");
	let scroller = stack.locator("..");
	let composer = chatInput(chat).locator("..");
	let lastMessageGap = async () => {
		await scroller.evaluate(element => element.scrollTop = element.scrollHeight);
		return chat.getByText("Transcript message 23", { exact: false })
			.evaluate(
				(message, field) =>
					(field as Element).getBoundingClientRect().top - message.getBoundingClientRect().bottom,
				await composer.elementHandle(),
			);
	};
	let firstMessagePosition = async () => {
		await scroller.evaluate(element => element.scrollTop = 0);
		return chat.getByText("The first message in a deliberately tall transcript.")
			.evaluate((message, scrollRoot) => {
				let messageBox = message.getBoundingClientRect();
				let scroller = scrollRoot as Element;
				let scrollerBox = scroller.getBoundingClientRect();
				return {
					clientHeight: scroller.clientHeight,
					messageBottom: messageBox.bottom,
					messageTop: messageBox.top,
					scrollerBottom: scrollerBox.bottom,
					scrollerTop: scrollerBox.top,
					scrollHeight: scroller.scrollHeight,
				};
			}, await scroller.elementHandle());
	};
	await expect(chat.getByText("Transcript message 23", { exact: false })).toBeVisible();
	expect(await lastMessageGap()).toBeGreaterThanOrEqual(32);
	let position = await firstMessagePosition();
	expect(position.scrollHeight).toBeGreaterThan(position.clientHeight);
	expect(position.messageTop).toBeGreaterThanOrEqual(position.scrollerTop);
	expect(position.messageBottom).toBeLessThanOrEqual(position.scrollerBottom);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect(chat).toBeVisible();
	expect(await lastMessageGap()).toBeGreaterThanOrEqual(32);
	position = await firstMessagePosition();
	expect(position.scrollHeight).toBeGreaterThan(position.clientHeight);
	expect(position.messageTop).toBeGreaterThanOrEqual(position.scrollerTop);
	expect(position.messageBottom).toBeLessThanOrEqual(position.scrollerBottom);
});

test("chat disables Send once a lost socket outlasts a blip", async ({ join, page }) => {
	let sockets: WebSocketRoute[] = [];
	let offline = false;
	await page.routeWebSocket("**/ws?**", route => {
		if (offline) return route.close();
		route.connectToServer();
		sockets.push(route);
	});

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });
	await draft.fill("A draft left during reconnect.");
	await expect(send).toBeEnabled();

	offline = true;
	await sockets.at(-1)!.close();
	// Inside the grace period nothing changes; after it, Send waits and the
	// draft stays.
	await expect(send).toBeEnabled();
	await expect(send).toBeDisabled();
	await expectChatValue(draft, "A draft left during reconnect.");
});

test("chat routes one Send action by @chopin without blocking room messages or its queue", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });

	await draft.fill("@chopin Start the migration.");
	await draft.press("Enter");
	await planner.started;
	await expect(chat.getByRole("button", { name: "Stop Chopin" })).toBeVisible();
	await expect(chat.getByRole("button", { name: "Stop Chopin" })).toHaveAttribute(
		"title",
		"Stop Chopin",
	);

	await expectChatValue(draft, "");
	if (
		await chat.getByRole("button", { name: "Talk to Chopin", exact: true }).getAttribute(
			"aria-pressed",
		) === "true"
	) {
		await draft.press("Shift+Tab");
	}
	await draft.fill("Keep the release notes brief.");
	await expect(send).toBeEnabled();
	await send.click();
	await draft.fill("@chopin Queue the rollback checks.");
	await send.click();
	await expect.poll(planner.sends).toEqual([
		{ text: "@chopin Start the migration.", to: "planner" },
		{ text: "Keep the release notes brief.", to: "room" },
		{ text: "@chopin Queue the rollback checks.", to: "planner" },
	]);
	await expect(chat.locator('[data-chat-state="queued"]')).toBeVisible();

	await fillChat(draft, "@chopin Keep\nthe new line.");
	await draft.press("Shift+Enter");
	await expectChatValue(draft, "@chopin Keep\nthe new line.\n");
	await draft.press("Enter");
	await expect.poll(planner.sends).toContainEqual({
		text: "@chopin Keep\nthe new line.",
		to: "planner",
	});

	await chat.getByRole("button", { name: "Stop Chopin" }).click();
	await expect(chat.locator('[data-chat-state="working"]')).toBeVisible();
	let next = chat.locator("[data-chat-entry]").filter({ hasText: "Queue the rollback checks." });
	let later = chat.locator("[data-chat-entry]").filter({ hasText: /Keep\s+the new line/ });
	await expect(next).toHaveCount(1);
	await expect(next).not.toHaveAttribute("data-chat-state", "queued");
	await expect(later).toHaveCount(1);
	await expect(later).toHaveAttribute("data-chat-state", "queued");
});

test("chat replaces the Planner working row with its response", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));

	await chatInput(chat).fill(
		"@chopin Draft the migration.",
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;

	let working = chat.locator('[data-chat-state="working"]');
	await expect(working).toBeVisible();
	await expect(working.getByText("Getting oriented")).toBeVisible();
	let timestamp = await page.evaluate(() =>
		new Date(1_700_000_001 * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	);
	await expect(
		working.locator("xpath=ancestor::*[@data-chat-entry][1]").getByText(
			`Started at ${timestamp}`,
			{ exact: true },
		),
	).toBeVisible();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(working).toBeVisible();
	await expect.poll(() =>
		working.evaluate(node =>
			node.getAnimations({ subtree: true }).some(animation => animation.playState === "running")
		)
	).toBe(false);

	planner.answer();
	await expect(working).toHaveCount(0);
	await expect(chat.getByText("The migration is ready.")).toBeVisible();
	await expect(chat.getByText(/^Started at /)).toHaveCount(0);
	await expect(chat.locator("[data-chat-entry]")).toHaveCount(2);
});

test("chat clears the Planner working row when a turn stops or fails", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));

	await chatInput(chat).fill(
		"@chopin Draft the migration.",
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;
	await expect(chat.locator('[data-chat-state="working"]')).toBeVisible();

	await chat.getByRole("button", { name: "Stop Chopin" }).click();
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);

	await chatInput(chat).fill("@chopin Try again.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect(chat.locator('[data-chat-state="working"]')).toBeVisible();
	planner.tool();
	await expect(chat.getByText("Gathering context", { exact: true })).toBeVisible();
	planner.fail();
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
	await expect(chat.getByText("Planner unavailable.")).toBeVisible();
	await chat.getByRole("button", { name: /Work details.*1 action.*1 interrupted/ }).click();
	await expect(chat.getByRole("button", { name: /Read plan.*Interrupted/ })).toBeVisible();

	await page.reload();
	await ready(page);
	await expect(chatPane(page).locator('[data-chat-state="working"]')).toHaveCount(0);
});

test(
	"chat progresses through real work and reveals tool input and results",
	async ({ join, page }, testInfo) => {
		let planner = await scriptPlanner(page);
		let chat = chatPane(await join("ana"));

		await chatInput(chat).fill(
			"@chopin Check the current plan.",
		);
		await chat.getByRole("button", { name: "Send message" }).click();
		await planner.started;
		await expect(chat.getByText("Getting oriented")).toBeVisible();
		let live = chat.locator("[data-chat-work-announcer]");
		await expect(live).toHaveText("Chopin has started.");
		await live.evaluate(element => element.setAttribute("data-live-node", "retained"));

		let read = planner.tool("read_plan", '{ "path": "<store.ts>" }');
		let work = chat.locator('[data-chat-state="working"]');
		let disclosure = work.getByRole("button", { name: /Gathering context/ });
		await expect(disclosure).toBeVisible();
		await expect(disclosure).toHaveAttribute("aria-expanded", "false");
		await expect(live).toHaveText("Chopin is gathering context.");
		await expect(live).toHaveAttribute("data-live-node", "retained");
		let controlled = await disclosure.getAttribute("aria-controls");
		await expect(chat.locator(`[id="${controlled}"]`)).toHaveCount(1);
		await expect(work.getByText("Read plan", { exact: true })).toHaveCount(0);
		await chat.screenshot({ path: testInfo.outputPath("work-active.png") });

		await disclosure.focus();
		await page.keyboard.press("Enter");
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		let tool = work.getByRole("button", { name: /Read plan.*Running/ });
		await expect(tool).toBeVisible();
		await expect(tool).toHaveAttribute("aria-expanded", "false");
		await tool.click();
		await expect(tool).toHaveAttribute("aria-expanded", "true");
		await expect(work.getByText('"path": "<store.ts>"', { exact: false })).toBeVisible();
		await chat.screenshot({ path: testInfo.outputPath("work-expanded.png") });

		planner.finishTool(read, "done", "Found the storage adapter.");
		await expect(work.getByText("Reviewing the next step")).toBeVisible();
		await expect(live).toHaveText("Chopin is preparing to continue.");
		await expect(live).toHaveAttribute("data-live-node", "retained");
		await expect(work.getByText("1 finished")).toBeVisible();
		await expect(work.getByText("Found the storage adapter.")).toBeVisible();
		await expect(work.getByRole("button", { name: /Reviewing the next step/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);

		let edit = planner.tool("edit_plan", '{ "block": "persistence" }');
		await expect(work.getByText("Making changes")).toBeVisible();
		await expect(live).toHaveText("Chopin is making changes.");
		await expect(live).toHaveAttribute("data-live-node", "retained");
		await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(1);
		planner.finishTool(edit, "done", "Document updated.");
		planner.stream();
		await expect(work.getByText("Writing a response")).toBeVisible();
		await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(1);
		await expect(chat.getByText("I found it.")).toBeVisible();

		planner.complete();
		await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
		let finished = chat.getByRole("button", { name: /Work details.*2 actions/ });
		await expect(finished).toHaveAttribute("aria-expanded", "true");
		await expect(live).toHaveText("Chopin turn ended. Work details remain available.");
		await expect(live).toHaveAttribute("data-live-node", "retained");
		await expect(chat.getByText("Document updated.")).not.toBeVisible();
		await chat.screenshot({ path: testInfo.outputPath("work-completed.png") });
	},
);

test("chat anchors active work when later tools arrive on another message", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await chatInput(chat).fill("@chopin Inspect and edit.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;

	let first = planner.tool();
	let work = chat.locator('[data-chat-state="working"]');
	await expect(work.getByText("Gathering context")).toBeVisible();
	let anchor = await work.getAttribute("data-chat-message-id");
	planner.finishTool(first, "done", "Read the document.");
	planner.tool("edit_plan", '{ "block": "persistence" }', true);
	await expect(work.getByText("Making changes")).toBeVisible();
	await expect(work).toHaveAttribute("data-chat-message-id", anchor!);
	await expect(work).toContainText("1 finished");
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(1);
	await work.getByRole("button", { name: /Making changes/ }).click();
	await expect(work.getByText("Read plan", { exact: true })).toBeVisible();
	await expect(work.getByText("Edit plan", { exact: true })).toBeVisible();

	await chat.getByRole("button", { name: "Stop Chopin" }).click();
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
	let completed = chat.locator(`[data-chat-message-id="${anchor}"]`);
	await expect(completed.getByRole("button", { name: /Work details.*2 actions/ })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(completed.getByText("Read plan", { exact: true })).toBeVisible();
	await expect(completed.getByText("Edit plan", { exact: true })).toBeVisible();
});

test("chat keeps an opened disclosure when prose precedes a separate tool entry", async ({ join, page }) => {
	let planner = await scriptPlanner(page);
	let chat = chatPane(await join("ana"));
	await chatInput(chat).fill("@chopin Inspect this.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await planner.started;
	planner.stream();
	let prose = chat.locator('[data-chat-message-id="answer"]');
	await expect(prose.getByText("Writing a response")).toBeVisible();
	let tool = planner.tool("read_plan", '{ "path": "src/store.ts" }', true);
	await expect(prose.getByText("Gathering context")).toBeVisible();
	let disclosure = prose.getByRole("button", { name: /Gathering context/ });
	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await disclosure.evaluate(element => element.setAttribute("data-open-node", "retained"));
	planner.finishTool(tool, "done", "Read the document.");
	planner.complete();
	let finished = prose.getByRole("button", { name: /Work details.*1 action/ });
	await expect(finished).toHaveAttribute("aria-expanded", "true");
	await expect(finished).toHaveAttribute("data-open-node", "retained");
	await expect(prose.getByText("Read plan", { exact: true })).toBeVisible();
	await expect(chat.getByRole("button", { name: /Work details.*1 action/ })).toHaveCount(1);
});

test("chat keeps opened work details on their prose anchor through a disconnect", async ({ join, page }) => {
	let sockets: WebSocketRoute[] = [];
	let reconnecting = Promise.withResolvers<void>();
	let releaseHistory: (() => void) | undefined;
	let turn: Chat.Turn = {
		id: "turn-offline",
		handle: "ana",
		started: 1_700_000_001,
		entryOffset: 1,
		responded: true,
	};
	let entries: Chat.Entry[] = [
		{
			id: "prompt",
			author: { kind: "member", handle: "ana" },
			text: "@chopin Inspect this.",
			ts: 1_700_000_000,
		},
		{ id: "prose", author: { kind: "agent" }, text: "I will inspect this.", ts: 1_700_000_001 },
		{
			id: "read-entry",
			author: { kind: "agent" },
			text: "",
			ts: 1_700_000_001,
			tools: [{ id: "read", name: "read_plan", status: "done", result: "Read it." }],
		},
		{
			id: "edit-entry",
			author: { kind: "agent" },
			text: "",
			ts: 1_700_000_001,
			tools: [{ id: "edit", name: "edit_plan", status: "running", args: "{}" }],
		},
	];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		sockets.push(route);
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as Chat.History;
			if (frame.kind !== "chat:history") return route.send(message);
			let history = JSON.stringify({ ...frame, busy: true, turn, entries });
			if (sockets.length === 2) {
				releaseHistory = () => route.send(history);
				reconnecting.resolve();
				return;
			}
			route.send(history);
		});
	});

	let chat = chatPane(await join("ana"));
	let prose = chat.locator('[data-chat-message-id="prose"]');
	let disclosure = prose.getByRole("button", { name: /Making changes/ });
	await disclosure.click();
	await disclosure.evaluate(element => element.setAttribute("data-open-node", "retained"));
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await sockets[0]!.close();
	await reconnecting.promise;
	await expect(prose).toHaveAttribute("data-chat-state", "disconnected");
	let offline = prose.getByRole("button", { name: /Work details.*2 actions.*Connection lost/ });
	await expect(offline).toHaveAttribute("data-open-node", "retained");
	await expect(offline).toHaveAttribute("aria-expanded", "true");
	await expect(prose.locator('[data-work-active="false"][data-work-disconnected="true"]'))
		.toHaveCount(1);
	await expect(prose.getByRole("button", { name: /Edit plan.*Last seen running/ })).toBeVisible();
	releaseHistory?.();
	await expect(prose).toHaveAttribute("data-chat-state", "working");
	await expect(prose.getByRole("button", { name: /Making changes/ })).toHaveAttribute(
		"data-open-node",
		"retained",
	);
});

test("chat history keeps one active work row after Planner prose and a later room message", async ({ join, page }) => {
	await injectChatHistory(page, frame => ({
		...frame,
		busy: true,
		turn: { id: "turn-1", handle: "ana", started: 1_700_000_000, entryOffset: 1, responded: true },
		entries: [
			{
				id: "prompt",
				author: { kind: "member", handle: "ana" },
				text: "@chopin Check the current plan.",
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

	let chat = chatPane(await join("ana"));
	await expect(chat.getByText("I found the issue.")).toBeVisible();
	await expect(chat.getByText("Please include the examples.")).toBeVisible();
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(1);
	await expect(chat.getByText("Reviewing the next step")).toBeVisible();
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
					turn: {
						id: "stale",
						handle: "ana",
						started: 1_700_000_000,
						entryOffset: 0,
						responded: false,
					},
				}));
				releaseHistory = () => route.send(message);
				historyHeld.resolve();
				return;
			}
			route.send(message);
		});
	});

	let chat = chatPane(await join("ana"));
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
	await sockets[0]!.close();
	await historyHeld.promise;
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);

	releaseHistory?.();
	await ready(page);
	await expect(chat.locator('[data-chat-state="working"]')).toHaveCount(0);
});

test(
	"chat keeps a running turn and its queue readable together",
	async ({ join, page }, testInfo) => {
		await injectChatHistory(page, frame => ({
			...frame,
			busy: true,
			turn: {
				id: "turn-1",
				handle: "maggie",
				started: 1_700_000_001,
				entryOffset: 1,
				responded: true,
			},
			entries: [
				{
					id: "m1",
					author: { kind: "member", handle: "maggie" },
					text: "@chopin Draft the migration plan.",
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
				{ id: "q1", handle: "ana", text: "@chopin" },
				{ id: "q2", handle: "sam", text: "Check the rollback path too." },
			],
		}));

		await join("ana");
		let chat = chatPane(page);
		let live = chat.getByRole("button", { name: /Making changes/ });

		await expect(live).toContainText("7 finished");
		await expect(chat.getByText("Edit plan", { exact: true })).toHaveCount(0);
		await expect(chat.getByRole("button", { name: "Stop Chopin" })).toHaveCount(0);

		let mine = chat.locator("[data-chat-entry]").filter({ hasText: "@chopin" });
		let theirs = chat.locator("[data-chat-entry]").filter({
			hasText: "Check the rollback path too.",
		});
		await expect(mine).toHaveAttribute("data-chat-state", "queued");
		await expect(mine.getByRole("button", { name: "Withdraw queued message" })).toBeVisible();
		await expect(theirs.getByRole("button", { name: "Withdraw queued message" })).toHaveCount(0);

		await testInfo.attach("running-turn-with-queue", {
			body: await chat.screenshot(),
			contentType: "image/png",
		});
	},
);

test("a Planner question waits on people and opens its card", async ({ join, page, seed }) => {
	let widget = "01K0N700000000000000000001";
	let question = {
		id: "01K0N700000000000000000002",
		header: "Rollout",
		question: "Should we ship a small pilot?",
		multiple: false,
		options: [{ id: "01K0N700000000000000000003", label: "Start small", description: "" }],
	};
	let definition = { questions: [question] };
	await seed(
		`# Migration

<Questionnaire id="${widget}" by="chopin">
<Question id="${question.id}" header="${question.header}" prompt="${question.question}" multiple="false">
<Option id="${question.options[0]!.id}" label="Start small" />
</Question>
</Questionnaire>
`,
		{
			revision: 1,
			questions: [{
				id: widget,
				definition,
				status: "open",
				origin: "planner",
				history: [],
				optionOrigins: {},
				editors: [],
			}],
			openQuestions: [{
				definition,
				id: widget,
				model: storedQuestion(definition),
				revision: 0,
				widget,
			}],
		},
	);
	let wire = await injectChatHistory(page, frame => ({
		...frame,
		busy: true,
		turn: {
			id: "turn-wait",
			handle: "ana",
			started: 1_700_000_001,
			entryOffset: 0,
			responded: true,
		},
		entries: [{
			id: "a1",
			author: { kind: "agent" },
			text: "I need a decision before I edit.",
			ts: 1_700_000_001,
			tools: [
				{ id: "t1", name: "read_plan", status: "done", took: 20 },
				{
					id: "t2",
					name: "ask",
					status: "running",
					args: JSON.stringify({ revision: 1, questions: [{ question: question.question }] }),
				},
			],
		}],
	}));

	await join("ana");
	let chat = chatPane(page);
	let waiting = chat.locator("[data-tool-waiting]");
	await expect(waiting).toHaveText(/Waiting on your decision/);
	await expect(waiting.locator(".chat-work-lattice")).toHaveCount(0);
	await waiting.getByRole("button", { name: "Open decision" }).click();
	await expect(
		page.locator(
			`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${widget}"]`,
		),
	).toBeFocused();

	wire.send({
		kind: "chat:tool",
		ts: 0,
		entry: "a1",
		activity: { id: "t2", name: "ask", status: "done", took: 4_000 },
	});
	wire.send({ kind: "chat:state", ts: 0, busy: false });
	await expect(waiting).toHaveCount(0);
	await expect(chat.getByRole("button", { name: /Work details.*2 actions/ })).toBeVisible();
});

test(
	"chat groups authors and collapses a finished tool run",
	async ({ join, seed }, testInfo) => {
		await seed("# Migration\n", {
			transcript: [
				{
					id: "m1",
					author: { kind: "member", handle: "maggie" },
					text: "@chopin Can you draft the migration?",
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
		let chat = chatPane(page);

		await expect(chat.getByText("Maggie", { exact: true })).toHaveCount(1);
		await expect(chat).toContainText("Can you draft the migration?");
		await expect(chat).not.toContainText("@");
		await expect(chat.getByText("Read file", { exact: true })).toHaveCount(0);

		let run = chat.getByRole("button", {
			name: /Work details.*4 actions.*1 failed.*1\.3s tool time/,
		});
		await expect(run).toBeVisible();
		let controlled = await run.getAttribute("aria-controls");
		expect(controlled).toBeTruthy();
		await expect(chat.locator(`[id="${controlled}"]`)).toHaveCount(1);
		await run.click();
		let toolLog = chat.locator('[data-motion-disclosure="chat-tools"]');
		let icon = run.locator("[data-feedback-icon]");
		await expect(run).toHaveAttribute("aria-controls", controlled!);
		await expect(icon).toHaveAttribute("data-feedback-icon", "open");
		await expect(chat.getByText("Read file", { exact: true })).toBeVisible();
		await expect(chat.getByText("Run tests", { exact: true })).toBeVisible();
		let failed = chat.getByRole("listitem").filter({ hasText: "Run tests" });
		await expect(failed).toHaveAttribute("data-tool-status", "failed");
		await run.click();
		await expect(run).toHaveAttribute("aria-controls", controlled!);
		await expect(toolLog).toHaveAttribute("aria-hidden", "true");
		await expect(toolLog).toHaveAttribute("inert", "");
		await run.click();
		await expect(run).toHaveAttribute("aria-controls", controlled!);
		await expect(toolLog).toHaveCount(1);
		await expect(toolLog).not.toHaveAttribute("aria-hidden", "true");
		await expect(toolLog).not.toHaveAttribute("inert", "");
		await expect(icon).toHaveAttribute("data-feedback-icon", "open");

		await expect(chat.locator("[data-chat-system]")).toContainText("Sam joined");

		await testInfo.attach("finished-turn-with-failure-open", {
			body: await chat.screenshot(),
			contentType: "image/png",
		});
	},
);

test("an empty room settles rather than loading forever", async ({ join }) => {
	let page = await join("ana");

	await expect(page.locator(".plan-status")).toHaveAttribute(
		"data-level",
		"hidden",
	);
});
