import {
	createChannel,
	seedChannel,
	seedChannelDescription,
	seedCompletedResearchWorkspace,
	testChannelPath,
} from "./database";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
}

test("typed references survive Planner send, reload, navigation, and a mobile conversation", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Reference parent\n");
	let targetRoom = crypto.randomUUID();
	await createChannel(port(baseURL!), targetRoom);
	await seedChannel(port(baseURL!), targetRoom, "# Referenced release\n");
	await seedChannelDescription(port(baseURL!), targetRoom, "RFC about referenced releases");
	let targetTitle = `Test ${targetRoom.slice(0, 8)}`;
	let targetPath = testChannelPath(targetRoom);
	let researchTitle = `OAuth evidence ${room.slice(0, 8)}`;
	let research = await seedCompletedResearchWorkspace(port(baseURL!), room, {
		question: researchTitle,
		report: {
			title: "OAuth report",
			summary: "OAuth evidence is durable.",
			finding: "The OAuth flow preserves evidence.",
			caveat: "Review before release.",
			source: { title: "OAuth source", url: "https://example.com/oauth" },
		},
	});
	let sent: Chat.Send[] = [];
	let attempts: Chat.Send[] = [];
	let rejectNext = true;

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
	await opened.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Conversation/ }).click();
	let conversation = opened.getByRole("complementary", { name: "Conversation" });
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	await expect(draft).toHaveAttribute("role", "combobox");
	await expect(draft).toHaveAttribute("aria-autocomplete", "list");
	await draft.fill("@chopin Compare #Te");
	let documents = conversation.getByRole("listbox", { name: "Document references" });
	await expect(documents).toBeVisible();
	await expectNoHorizontalOverflow(opened);
	let pickerBox = await conversation.locator("[data-chat-reference-picker]").boundingBox();
	expect(pickerBox).not.toBeNull();
	expect(pickerBox!.x).toBeGreaterThanOrEqual(0);
	expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(390);
	expect(pickerBox!.y).toBeGreaterThanOrEqual(0);
	expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(520);
	await draft.press("Escape");
	await expect(documents).toHaveCount(0);
	await draft.pressSequentially("s");
	await draft.press("Backspace");
	expect(await documents.getByRole("option", { name: targetTitle, exact: true }).count()).toBe(0);
	await expect(documents.getByRole("option", { name: targetTitle, exact: true })).toBeVisible();
	await expect(documents.getByText("RFC about referenced releases", { exact: true })).toBeVisible();
	await draft.press("ArrowDown");
	await draft.press("ArrowUp");
	await draft.press("Enter");

	let scopedResearch = opened.waitForResponse(response =>
		response.request().method() === "GET"
		&& new URL(response.url()).pathname === `/api/channels/${room}/research-workspaces`
	);
	await draft.pressSequentially(" and %OAuth");
	await scopedResearch;
	let researchList = conversation.getByRole("listbox", {
		name: "Research Workspace references",
	});
	await researchList.getByRole("option").filter({ hasText: researchTitle }).click();
	await draft.pressSequentially(" with [external docs](https://example.com).", { delay: 1 });
	let expected =
		`@chopin Compare #${targetTitle} and %${researchTitle} with [external docs](https://example.com).`;
	await expect(draft).toHaveValue(expected);
	let send = conversation.getByRole("button", { name: "Send message" });
	await send.click();
	await expect(send).toBeDisabled();
	await expect(draft).toHaveAttribute("readonly", "");
	await expect(draft).toHaveAttribute("aria-disabled", "true");
	let error = conversation.getByRole("alert");
	await expect(error).toContainText("Message not sent: Unavailable");
	expect((await error.textContent())!.length).toBeLessThan(150);
	await expect(draft).toHaveValue(expected);
	await expect(draft).toBeFocused();
	await expect(send).toBeEnabled();
	await send.click();

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
			{
				kind: "research",
				workspaceId: research.workspaceId,
				start: expected.indexOf(`%${researchTitle}`),
				end: expected.indexOf(`%${researchTitle}`) + researchTitle.length + 1,
			},
		],
	});
	await expect(draft).toHaveValue("");
	await expect(draft).toBeFocused();
	let documentLink = conversation.getByRole("link", { name: `#${targetTitle}`, exact: true });
	let researchLink = conversation.getByRole("link", { name: `%${researchTitle}`, exact: true });
	await expect(documentLink).toHaveAttribute("href", targetPath);
	await expect(documentLink).not.toHaveAttribute("target", "_blank");
	await expect(researchLink).toHaveAttribute("href", research.path);
	await expect(conversation.getByRole("link", { name: "external docs", exact: true }))
		.toHaveAttribute("target", "_blank");

	await opened.reload();
	await ready(opened);
	await opened.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Conversation/ }).click();
	documentLink = opened.getByRole("complementary", { name: "Conversation" })
		.getByRole("link", { name: `#${targetTitle}`, exact: true });
	await expect(documentLink).toBeVisible();
	await documentLink.click();
	await expect(opened).toHaveURL(url => url.pathname === targetPath);
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

	let conversation = (await join("ana")).locator("#pane-chat");
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	await expect(draft).toHaveRole("textbox");
	await expect(draft).not.toHaveAttribute("aria-autocomplete", "list");
	await draft.fill("See #Ask @chopin");
	await page.waitForTimeout(250);
	await expect(conversation.getByRole("listbox")).toHaveCount(0);
	await conversation.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ text: "See #Ask @chopin", to: "planner" });
	expect(sent[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
	expect(sent[0]!.references).toBeUndefined();
});

test("an empty picker leaves arrows and Enter to the textarea", async ({ join, page, seed }) => {
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

	let conversation = (await join("ana")).locator("#pane-chat");
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	let value = `No result #missing-${crypto.randomUUID()}`;
	await draft.fill(value);
	await expect(conversation.getByText("No matching documents.", { exact: true })).toBeVisible();
	await draft.press("ArrowLeft");
	expect(await draft.evaluate(element => (element as HTMLTextAreaElement).selectionStart))
		.toBe(value.length - 1);
	await draft.press("End");
	await draft.press("Enter");
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ text: value, to: "room" });
	expect(sent[0]!.references).toBeUndefined();
	await expect(draft).toHaveValue("");
});

test("a disconnect rejects a pending send without losing its draft", async ({ join, page, seed }) => {
	await seed("# Pending chat send\n");
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind === "chat:send") return void route.close();
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});

	let conversation = (await join("ana")).locator("#pane-chat");
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	let value = "Keep this draft through disconnect";
	await draft.fill(value);
	await conversation.getByRole("button", { name: "Send message" }).click();
	await expect(conversation.getByRole("alert")).toContainText("Check the connection and try again");
	await expect(draft).toHaveValue(value);
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

	let conversation = (await join("ana")).locator("#pane-chat");
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	await draft.fill("Legacy delivery");
	await conversation.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent).toHaveLength(1);
	expect(sent[0]!.requestId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	await expect(draft).toHaveValue("");
	await expect(draft).toBeFocused();
});

test("the composer stays read-only until fresh chat history arrives", async ({ join, page, seed }) => {
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

	let conversation = (await join("ana")).locator("#pane-chat");
	let draft = conversation.getByPlaceholder("Use @chopin to ask Chopin");
	await expect.poll(() => releaseHistory !== undefined).toBe(true);
	await expect(draft).toHaveAttribute("readonly", "");
	await expect(draft).toHaveAttribute("aria-disabled", "true");
	await expect(conversation.getByRole("button", { name: "Send message" })).toBeDisabled();
	releaseHistory!();
	await expect(draft).toBeEditable();
	await expect(draft).toHaveAttribute("aria-disabled", "false");
	await draft.fill("Now synchronized");
	await expect(conversation.getByRole("button", { name: "Send message" })).toBeEnabled();
});
