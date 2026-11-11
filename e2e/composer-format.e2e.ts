/**
 * The message box's formatting toolbar and its @ button: each mark inserts Markdown into the draft
 * round the selection without taking the draft's focus, Aa turns the toolbar off and on for the
 * person and the choice is kept, and the message goes out exactly as written.
 */

import { chatCaret, chatInput, expectChatValue } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function toolbar(chat: Locator) {
	return chat.getByRole("toolbar", { name: "Formatting" });
}

/** What the page sent to the server as Chat messages, in order. */
async function recordSends(page: Page) {
	let texts: string[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as { kind?: string; text?: string };
					if (frame.kind === "chat:send") texts.push(frame.text ?? "");
				} catch {
					// Not a frame the spec reads.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return texts;
}

/** The last `count` characters of the draft, selected, with the caret at its end. */
async function selectTail(draft: Locator, count: number) {
	await draft.press("End");
	for (let index = 0; index < count; index++) await draft.press("Shift+ArrowLeft");
}

test("the toolbar names its marks, and each inserts Markdown round the selection without taking the draft's focus", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let bar = toolbar(chat);
	await expect(bar.getByRole("button")).toHaveText(["", "", "", "", "", "", "", ""]);
	for (
		let name of [
			"Bold",
			"Italic",
			"Strikethrough",
			"Link",
			"Numbered list",
			"Bulleted list",
			"Code",
			"Code block",
		]
	) {
		await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
	}

	await draft.fill("make it clear");
	await selectTail(draft, 5);
	await bar.getByRole("button", { name: "Bold", exact: true }).click();
	await expectChatValue(draft, "make it **clear**");
	// The draft kept the focus, and the word is still selected inside the marks.
	await expect(draft).toBeFocused();
	await bar.getByRole("button", { name: "Bold", exact: true }).click();
	await expectChatValue(draft, "make it clear");

	await bar.getByRole("button", { name: "Italic", exact: true }).click();
	await expectChatValue(draft, "make it _clear_");
	await bar.getByRole("button", { name: "Italic", exact: true }).click();
	await bar.getByRole("button", { name: "Strikethrough", exact: true }).click();
	await expectChatValue(draft, "make it ~~clear~~");
	await bar.getByRole("button", { name: "Strikethrough", exact: true }).click();
	await bar.getByRole("button", { name: "Code", exact: true }).click();
	await expectChatValue(draft, "make it `clear`");
	await bar.getByRole("button", { name: "Code", exact: true }).click();

	// A link wraps the selection and leaves the address selected, ready to type.
	await bar.getByRole("button", { name: "Link", exact: true }).click();
	await expectChatValue(draft, "make it [clear](url)");
	await page_type(draft, "https://example.test");
	await expectChatValue(draft, "make it [clear](https://example.test)");
});

/** Types at the caret, which a toolbar press must have left in the draft. */
async function page_type(draft: Locator, text: string) {
	await draft.page().keyboard.type(text);
}

test("a list prefixes the lines the selection touches, and a code block fences the draft", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let bar = toolbar(chat);
	await draft.fill("one");
	await draft.press("Shift+Enter");
	await draft.page().keyboard.insertText("two");
	await draft.press("Control+a");
	await bar.getByRole("button", { name: "Numbered list", exact: true }).click();
	await expectChatValue(draft, "1. one\n2. two");
	await bar.getByRole("button", { name: "Numbered list", exact: true }).click();
	await expectChatValue(draft, "one\ntwo");
	await bar.getByRole("button", { name: "Bulleted list", exact: true }).click();
	await expectChatValue(draft, "- one\n- two");
	await draft.fill("x = 1");
	await draft.press("Control+a");
	await bar.getByRole("button", { name: "Code block", exact: true }).click();
	await expectChatValue(draft, "```\nx = 1\n```");
});

test("the message goes out as written, Markdown and all", async ({ join, page }) => {
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("ship it now");
	await selectTail(draft, 3);
	await toolbar(chat).getByRole("button", { name: "Bold", exact: true }).click();
	await draft.press("Enter");
	await expect.poll(() => sent).toEqual(["ship it **now**"]);
	await expect(chat.getByText("now", { exact: true })).toBeVisible();
});

test("Aa turns the toolbar off and on, and the choice is kept for the person across a reload", async ({ join, page }) => {
	let chat = chatPane(await join("ana"));
	let aa = chat.getByRole("button", { name: "Formatting", exact: true });
	await expect(toolbar(chat)).toBeVisible();
	await expect(aa).toHaveAttribute("aria-pressed", "true");
	await aa.click();
	await expect(toolbar(chat)).toHaveCount(0);
	await expect(aa).toHaveAttribute("aria-pressed", "false");

	await page.reload();
	let after = chatPane(page);
	await expect(chatInput(after)).toBeVisible();
	await expect(toolbar(after)).toHaveCount(0);
	await expect(after.getByRole("button", { name: "Formatting", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await after.getByRole("button", { name: "Formatting", exact: true }).click();
	await expect(toolbar(after)).toBeVisible();
});

test("the @ button puts an @ at the caret and opens the mentions", async ({ join }) => {
	let page = await join("ana");
	await join("cy");
	let chat = chatPane(page);
	let draft = chatInput(chat);
	await draft.fill("hello");
	await chat.getByRole("button", { name: "Mention someone", exact: true }).click();
	await expectChatValue(draft, "hello @");
	expect(await chatCaret(draft)).toBe("hello @".length);
	await expect(chat.locator("[data-chat-mention-picker]").getByRole("option", { name: "cy" }))
		.toBeVisible();
});
