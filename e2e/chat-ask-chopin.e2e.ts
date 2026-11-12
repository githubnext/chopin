/**
 * Asking chopin is a mention in the draft's words. The sparkle button and Command+J or Control+J
 * write `@chopin` into the draft, the same mention the @ menu writes and the same words a person
 * could type: at the caret when the field has it, otherwise at the start. Nothing else is drawn,
 * Backspace takes it out like any words, and who a message goes to follows its words.
 */

import { chatCaret, chatInput, expectChatValue } from "./chat-input";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function askButton(chat: Locator) {
	return chat.getByRole("button", { name: "Ask chopin", exact: true });
}

/** The mention token the draft draws for `@chopin`, whichever way it got there. */
function chopinMention(chat: Locator) {
	return chatInput(chat).locator('.draft-mention[data-mention="chopin"]');
}

/** What the composer drew for the chip it no longer has. */
async function expectNoChip(chat: Locator): Promise<void> {
	await expect(chat.getByRole("group", { name: "Asking chopin" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Remove chopin" })).toHaveCount(0);
	await expect(chat.locator(".composer-chip, [data-slot='directive-text-chip']")).toHaveCount(0);
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
}

/** What the browser puts on the wire, the Planner being off in this suite. */
async function recordSends(page: Page): Promise<Chat.Send[]> {
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as Chat.Send;
					if (frame.kind === "chat:send") sent.push(frame);
				} catch {
					// The server owns frames that are not JSON.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return sent;
}

/** github.com is not reachable from the harness; answer with a flat tile. */
async function stubAvatars(page: Page): Promise<void> {
	await page.route("https://github.com/*.png*", route => {
		let login = new URL(route.request().url()).pathname.slice(1, -".png".length);
		return route.fulfill({
			contentType: "image/svg+xml",
			body:
				`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${
					login.charCodeAt(0) * 11 % 360
				} 40% 55%)"/></svg>`,
		});
	});
}

/** The wire's account of a message: who it went to and the words that went. */
function lastSent(sent: Chat.Send[]) {
	return sent.at(-1) && { text: sent.at(-1)!.text, to: sent.at(-1)!.to };
}

test("the empty draft says how to ask Chopin, and the button names its chord", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team, or @chopin to ask");
	await expect(askButton(chat)).toBeEnabled();
	await expect(askButton(chat)).toHaveAttribute("data-tooltip-shortcut", /^(Ctrl\+J|⌘J)$/);
	await expect(askButton(chat)).not.toHaveAttribute("aria-pressed");
	await expectNoChip(chat);
});

test("the sparkle button writes @chopin at the start of an empty draft, and nothing else", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await askButton(chat).click();
	await expectChatValue(draft, "@chopin ");
	await expect(draft).toBeFocused();
	expect(await chatCaret(draft)).toBe("@chopin ".length);
	// The mention the @ menu writes, drawn in the words, and no chip beside them.
	await expect(chopinMention(chat)).toHaveText("@chopin");
	await expectNoChip(chat);
	// The button is not spent: it stays as it was.
	await expect(askButton(chat)).toBeEnabled();
	await page.keyboard.type("outline it");
	await expectChatValue(draft, "@chopin outline it");
});

test("with the caret in the words, the button and the chord write the mention there", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("outline the export options");
	await draft.press("Home");
	for (let index = 0; index < "outline".length; index++) await draft.press("ArrowRight");

	await askButton(chat).click();
	await expectChatValue(draft, "outline @chopin the export options");
	await expect(draft).toBeFocused();
	expect(await chatCaret(draft)).toBe("outline @chopin ".length);
	await expectNoChip(chat);

	await draft.fill("what breaks offline?");
	await draft.press("End");
	await draft.press("ControlOrMeta+j");
	await expectChatValue(draft, "what breaks offline? @chopin ");
	expect(await chatCaret(draft)).toBe("what breaks offline? @chopin ".length);
	await expect(chopinMention(chat)).toHaveText("@chopin");
});

test("a draft that already mentions chopin gets no second mention, only the caret after it", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("could @Chopin look at this?");
	await page.keyboard.press("Escape");
	await draft.press("End");

	await draft.press("ControlOrMeta+j");
	await expectChatValue(draft, "could @Chopin look at this?");
	expect(await chatCaret(draft)).toBe("could @Chopin ".length);

	await draft.press("End");
	await askButton(chat).click();
	await expectChatValue(draft, "could @Chopin look at this?");
	await expect(draft).toBeFocused();
	expect(await chatCaret(draft)).toBe("could @Chopin ".length);
	// The @ menu does not open over a mention that is already whole.
	await expect(chat.getByRole("listbox", { name: "Mentions" })).toHaveCount(0);
});

test("choosing chopin in the @ menu writes the same mention as the button", async ({ join, page }) => {
	await enablePlanner(page);
	await stubAvatars(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("Hey @ch");
	let menu = chat.getByRole("listbox", { name: "Mentions" });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("option", { name: /^Chopin/i })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await draft.press("Enter");
	await expect(menu).toHaveCount(0);
	await expectChatValue(draft, "Hey @chopin ");
	expect(await chatCaret(draft)).toBe("Hey @chopin ".length);
	await expect(chopinMention(chat)).toHaveText("@chopin");
	await expectNoChip(chat);
});

test("Backspace takes the mention out like any words, and the message is the team's again", async ({ join, page }) => {
	await enablePlanner(page);
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await askButton(chat).click();
	await expectChatValue(draft, "@chopin ");
	for (let index = 0; index < "@chopin ".length; index++) await draft.press("Backspace");
	await expectChatValue(draft, "");
	await expect(chopinMention(chat)).toHaveCount(0);
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team, or @chopin to ask");
	await expectNoChip(chat);
	await page.keyboard.type("Thanks for the update.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({ text: "Thanks for the update.", to: "room" });
});

test("who a message goes to follows its words: the button's mention, a typed one, or none", async ({ join, page }) => {
	await enablePlanner(page);
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);

	await askButton(chat).click();
	await page.keyboard.type("Outline the export options.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({
		text: "@chopin Outline the export options.",
		to: "planner",
	});
	// Nothing stays on: the next draft is empty and goes to the team unless it mentions chopin.
	await expectChatValue(draft, "");
	await draft.fill("Back to the team.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({ text: "Back to the team.", to: "room" });

	// A typed mention, in any case and anywhere in the message, asks chopin just the same.
	for (let text of ["@chopin And the rollback checks.", "Could @Chopin look at this?"]) {
		await draft.fill(text);
		await page.keyboard.press("Escape");
		await chat.getByRole("button", { name: "Send message" }).click();
		await expect.poll(() => lastSent(sent)).toEqual({ text, to: "planner" });
	}
});

test("on a phone the button writes the mention too, and the box stays inside the screen", async ({ join }) => {
	// A touch context is its own, so the Planner and the wire are set up on it, then it is opened again.
	let page = await join("ana", PHONE);
	await enablePlanner(page);
	let sent = await recordSends(page);
	await page.reload();
	let chat = chatPane(page);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).tap();
	await expect.poll(async () => (await chat.boundingBox())?.x).toBe(0);
	let draft = chatInput(chat);

	await askButton(chat).tap();
	await expectChatValue(draft, "@chopin ");
	await expect(chopinMention(chat)).toBeVisible();
	await expectNoChip(chat);
	await page.keyboard.type("what is left?");
	await expectChatValue(draft, "@chopin what is left?");
	await expectNoHorizontalOverflow(page);

	await chat.getByRole("button", { name: "Send message" }).tap();
	await expect.poll(() => lastSent(sent)).toEqual({ text: "@chopin what is left?", to: "planner" });
	await expectChatValue(draft, "");
});

test("there is no way to ask where the document has no Planner", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team");
	await expect(askButton(chat)).toHaveCount(0);
	await draft.fill("hello");
	await draft.press("ControlOrMeta+j");
	await expectChatValue(draft, "hello");
	await expectNoChip(chat);
});
