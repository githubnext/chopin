import { chatCaret, chatInput, expectChatValue } from "./chat-input";
import { seedChannelDescription, seedChildChannel } from "./database";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
}

test("typed references survive Planner send, reload, navigation, and a mobile chat", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Reference parent\n");
	let targetRoom = crypto.randomUUID();
	let targetTitle = `Source review ${targetRoom.slice(0, 8)}`;
	let seededTarget = await seedChildChannel(
		port(baseURL!),
		room,
		targetRoom,
		targetTitle,
		"# Referenced child\n",
	);
	await seedChannelDescription(port(baseURL!), targetRoom, "RFC about referenced releases");
	let targetPath = seededTarget.path;
	let sent: Chat.Send[] = [];
	let attempts: Chat.Send[] = [];
	let rejectNext = true;
	let researchCatalogueCalls = 0;
	page.on("request", request => {
		if (
			request.method() === "GET"
			&& new URL(request.url()).pathname === `/api/channels/${room}/research-workspaces`
		) researchCatalogueCalls++;
	});

	await enablePlanner(page);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as Chat.Send;
					if (frame.kind === "chat:send") {
						attempts.push(frame);
						if (rejectNext) {
							rejectNext = false;
							setTimeout(() =>
								route.send(JSON.stringify({
									kind: "session:error",
									ts: 0,
									rid: frame.rid,
									message: `Unavailable ${"detail ".repeat(40)}`,
								})), 150);
							return;
						}
						sent.push(frame);
					}
				} catch {
					// The server still owns malformed and non-chat frames.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});

	await page.setViewportSize({ width: 390, height: 520 });
	let opened = await join("ana");
	let parent = await (await opened.request.get(`/api/channels/${room}`)).json();
	targetPath = `/documents/octo-org/score/${parent.channel.slug}/children/${seededTarget.slug}`;
	await opened.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Chat/ }).click();
	let chat = opened.getByRole("complementary", { name: "Chat" });
	let draft = chatInput(chat);
	await expect(draft).toHaveAttribute("role", "combobox");
	await expect(draft).toHaveAttribute("aria-autocomplete", "list");
	await draft.fill(`@chopin Compare #${targetRoom.slice(0, 8)}`);
	let documents = chat.getByRole("listbox", { name: "Document references" });
	await expect(documents).toBeVisible();
	await expectNoHorizontalOverflow(opened);
	await expectInsideViewport(chat.locator("[data-chat-reference-picker]"));
	await draft.press("Escape");
	await expect(documents).toHaveCount(0);
	await draft.pressSequentially("s");
	await draft.press("Backspace");
	expect(await documents.getByRole("option", { name: targetTitle, exact: true }).count()).toBe(0);
	let target = documents.getByRole("option", { name: targetTitle, exact: true });
	await expect(target).toBeVisible();
	await expect(target.getByText("RFC about referenced releases", { exact: true })).toBeVisible();
	await draft.press("ArrowDown");
	await draft.press("ArrowUp");
	await expect(target).toHaveAttribute("aria-selected", "true");
	await draft.press("Enter");

	await draft.pressSequentially(" and %OAuth");
	await opened.waitForTimeout(250);
	await expect(chat.getByRole("listbox")).toHaveCount(0);
	expect(researchCatalogueCalls).toBe(0);
	await draft.pressSequentially(" with [external docs](https://example.com).", { delay: 1 });
	let expected =
		`@chopin Compare #${targetTitle} and %OAuth with [external docs](https://example.com).`;
	await expectChatValue(draft, expected);
	let send = chat.getByRole("button", { name: "Send message" });
	await send.click();

	// A refusal is said on the message itself, in a line of its own, never above the composer, and
	// the composer is free at once.
	let message = chat.locator("[data-chat-message-id]").filter({ hasText: "Compare" });
	let failed = message.locator("[data-chat-failed]");
	await expect(failed).toContainText("Couldn't send.");
	await expect(failed).toContainText("Unavailable");
	expect((await failed.textContent())!.length).toBeLessThan(200);
	await expect(chat.getByRole("alert")).toHaveCount(0);
	await expectChatValue(draft, "");
	await expect(draft).toHaveAttribute("contenteditable", "true");
	await expect(send).toBeDisabled();

	// Try again sends it as it was: the same request, so the server takes it once.
	await message.getByRole("button", { name: "Try again" }).click();
	await expect.poll(() => sent).toHaveLength(1);
	expect(attempts).toHaveLength(2);
	expect(attempts[0]!.requestId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(attempts[1]!.requestId).toBe(attempts[0]!.requestId);
	expect(sent[0]).toMatchObject({
		requestId: attempts[0]!.requestId,
		text: expected,
		to: "planner",
		references: [
			{
				kind: "document",
				channelId: targetRoom,
				start: expected.indexOf(`#${targetTitle}`),
				end: expected.indexOf(`#${targetTitle}`) + targetTitle.length + 1,
			},
		],
	});
	await expectChatValue(draft, "");
	let documentLink = chat.getByRole("link", { name: `#${targetTitle}`, exact: true });
	await expect(documentLink).toHaveAttribute("href", targetPath);
	await expect(documentLink).not.toHaveAttribute("target", "_blank");
	await expect(chat.getByText("%OAuth", { exact: false })).toBeVisible();
	await expect(chat.getByRole("link", { name: "external docs", exact: true }))
		.toHaveAttribute("target", "_blank");

	await opened.reload();
	await ready(opened);
	await opened.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Chat/ }).click();
	documentLink = opened.getByRole("complementary", { name: "Chat" })
		.getByRole("link", { name: `#${targetTitle}`, exact: true });
	await expect(documentLink).toBeVisible();
	await documentLink.click();
	await expect(opened.locator(`[data-workspace-room="${targetRoom}"]`)).toBeVisible();
	let targetDetail = await (await opened.request.get(`/api/channels/${targetRoom}`)).json();
	await expect(opened).toHaveURL(url =>
		url.pathname
			=== `/documents/octo-org/score/${parent.channel.slug}/children/${targetDetail.channel.slug}`
	);
});

test("a server without chat references leaves typed tokens ordinary", async ({ join, page, seed }) => {
	await seed("# Capability fallback\n");
	let sent: Chat.Send[] = [];
	await enablePlanner(page);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind: string } & Record<string, unknown>;
			route.send(JSON.stringify(
				frame.kind === "session:hello" ? { ...frame, chatReferences: false } : frame,
			));
		});
	});

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	// The `@` list needs no server support, so the composer is a combobox either way.
	await expect(draft).toHaveRole("combobox");
	await draft.fill("See #Ask @chopin");
	await page.waitForTimeout(250);
	await expect(chat.getByRole("listbox", { name: "Document references" })).toHaveCount(0);
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ text: "See #Ask @chopin", to: "planner" });
	expect(sent[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
	expect(sent[0]!.references).toBeUndefined();
});

test("an empty picker leaves arrows and Enter to the editor", async ({ join, page, seed }) => {
	await seed("# Empty picker\n");
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let value = `No result #missing-${crypto.randomUUID()}`;
	await draft.fill(value);
	await expect(
		chat.getByRole("listbox", { name: "Document references", exact: true }).getByRole("status"),
	).toContainText("No matching documents.");
	await draft.press("ArrowLeft");
	expect(await chatCaret(draft))
		.toBe(value.length - 1);
	await draft.press("End");
	await draft.press("Enter");
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ text: value, to: "room" });
	expect(sent[0]!.references).toBeUndefined();
	await expectChatValue(draft, "");
});

/** Answers each Chat send by closing the connection under it, or by refusing it as a server would. */
async function answerSends(page: Page, answer: "close" | "refuse") {
	let connections = { opened: 0 };
	await page.routeWebSocket("**/ws?**", route => {
		connections.opened++;
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; rid: string };
				if (frame.kind === "chat:send") {
					if (answer === "close") return void route.close();
					return void route.send(JSON.stringify({
						kind: "session:error",
						ts: 0,
						rid: frame.rid,
						message: "Unavailable",
					}));
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return connections;
}

test("a disconnect rejects a pending send without losing its draft, and leaves no strip beside the composer", async ({ join, page, seed }) => {
	await seed("# Pending chat send\n");
	let connections = await answerSends(page, "close");

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let value = "Keep this draft through disconnect";
	await draft.fill(value);
	let before = connections.opened;
	await chat.getByRole("button", { name: "Send message" }).click();
	// The connection comes back, and the connection banner, not the composer, spoke for it.
	await expect.poll(() => connections.opened).toBeGreaterThan(before);
	await expect(chat.getByRole("alert")).toHaveCount(0);
	await expect(chat.getByText(/Message not sent|Check the connection/)).toHaveCount(0);
	await expectChatValue(draft, value);
	await expect(draft).toBeFocused();
});

test("a refused send keeps its draft, and its strip does not animate when motion is reduced", async ({ join, page, seed }) => {
	await seed("# Refused chat send\n");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await answerSends(page, "refuse");

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let value = "Keep this draft through a refusal";
	await draft.fill(value);
	await page.evaluate(() => {
		let record = { starts: 0 };
		Reflect.set(window, "__refusalAlertTransitions", record);
		document.addEventListener("transitionstart", event => {
			if (
				event.target instanceof Element
				&& event.target.matches('[data-motion-feedback="alert"], [data-error-banner]')
			) record.starts++;
		}, true);
	});
	await chat.getByRole("button", { name: "Send message" }).click();
	let error = chat.getByRole("alert");
	await expect(error).toContainText("Message not sent: Unavailable");
	await expect(error).toHaveCSS("transition-duration", "0s");
	// Nor does it enter: with reduced motion the banner has no animation either.
	await expect(error).toHaveCSS("animation-name", "none");
	await error.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	expect(
		await page.evaluate(() =>
			(Reflect.get(window, "__refusalAlertTransitions") as { starts: number }).starts
		),
	).toBe(0);
	await expectChatValue(draft, value);
	await expect(draft).toBeFocused();
});

test("legacy delivery clears immediately without waiting for an acknowledgement", async ({ join, page, seed }) => {
	await seed("# Legacy chat send\n");
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") {
					sent.push(frame);
					return;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind: string } & Record<string, unknown>;
			route.send(JSON.stringify(
				frame.kind === "session:hello" ? { ...frame, chatSendAcks: false } : frame,
			));
		});
	});

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("Legacy delivery");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]!.requestId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	await expectChatValue(draft, "");
	await expect(draft).toBeFocused();
});

test("a send made before fresh chat history arrives waits for it", async ({ join, page, seed }) => {
	await seed("# Delayed chat history\n");
	let releaseHistory: (() => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "chat:history" && !releaseHistory) {
					releaseHistory = () => route.send(message);
					return;
				}
			}
			route.send(message);
		});
	});

	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await expect.poll(() => releaseHistory !== undefined).toBe(true);
	await expect(draft).toBeEditable();
	await expect(draft).toHaveAttribute("aria-disabled", "false");
	await draft.fill("Now synchronized");
	await draft.press("Enter");
	// Held, not refused, and not sent against a transcript that is not current.
	await expect(chat.locator(".composer-surface")).toHaveAttribute("aria-busy", "true");
	await expectChatValue(draft, "Now synchronized");
	releaseHistory!();
	await expectChatValue(draft, "");
	await expect(chat.getByText("Now synchronized", { exact: true })).toBeVisible();
});
