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
	// The selection the page reports is the one a mark applies to.
	await expect.poll(() => draft.page().evaluate(() => window.getSelection()!.toString().length))
		.toBe(count);
}

test("the toolbar names its marks, and each formats the selection in place, pressed while the caret is in it", async ({ join }) => {
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
		await expect(bar.getByRole("button", { name, exact: true })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	}
	let bold = bar.getByRole("button", { name: "Bold", exact: true });

	await draft.fill("make it clear");
	await selectTail(draft, 5);
	await bold.click();
	// The draft draws it bold, with no marks in its words, and is sent as Markdown.
	await expect(draft.locator("strong")).toHaveText("clear");
	await expect(draft).toHaveText("make it clear");
	await expectChatValue(draft, "make it **clear**");
	await expect(bold).toHaveAttribute("aria-pressed", "true");
	// The draft kept the focus and the selection.
	await expect(draft).toBeFocused();
	await bold.click();
	await expectChatValue(draft, "make it clear");
	await expect(bold).toHaveAttribute("aria-pressed", "false");

	await bar.getByRole("button", { name: "Italic", exact: true }).click();
	await expect(draft.locator("em")).toHaveText("clear");
	await expectChatValue(draft, "make it _clear_");
	await bar.getByRole("button", { name: "Italic", exact: true }).click();
	await bar.getByRole("button", { name: "Strikethrough", exact: true }).click();
	await expectChatValue(draft, "make it ~~clear~~");
	await bar.getByRole("button", { name: "Strikethrough", exact: true }).click();
	await bar.getByRole("button", { name: "Code", exact: true }).click();
	await expect(draft.locator("code")).toHaveText("clear");
	await expectChatValue(draft, "make it `clear`");
	await bar.getByRole("button", { name: "Code", exact: true }).click();
	await expectChatValue(draft, "make it clear");

	// A link asks for its address over the box, and draws the words as a link.
	await bar.getByRole("button", { name: "Link", exact: true }).click();
	let address = chat.getByRole("textbox", { name: "Link", exact: true });
	await expect(address).toBeFocused();
	await address.fill("example.test/plan");
	await address.press("Enter");
	await expect(draft.locator("a")).toHaveText("clear");
	await expectChatValue(draft, "make it [clear](https://example.test/plan)");
	await expect(draft).toBeFocused();
	await expect(bar.getByRole("button", { name: "Link", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("a list or a code block takes the lines the selection touches", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let bar = toolbar(chat);
	await draft.fill("one");
	await draft.press("Shift+Enter");
	await draft.page().keyboard.insertText("two");
	await draft.press("ControlOrMeta+a");
	await bar.getByRole("button", { name: "Numbered list", exact: true }).click();
	await expect(draft.getByRole("listitem")).toHaveText(["one", "two"]);
	await expectChatValue(draft, "1. one\n2. two");
	await bar.getByRole("button", { name: "Numbered list", exact: true }).click();
	await expect(draft.getByRole("listitem")).toHaveCount(0);
	await bar.getByRole("button", { name: "Bulleted list", exact: true }).click();
	await expectChatValue(draft, "- one\n- two");
	await draft.fill("x = 1");
	await draft.press("ControlOrMeta+a");
	await bar.getByRole("button", { name: "Code block", exact: true }).click();
	await expect(draft.locator("pre")).toHaveText("x = 1");
	await expectChatValue(draft, "```\nx = 1\n```");
});

test("Slack's keys format the selection, and Ctrl+U is refused", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("go now");
	await selectTail(draft, 3);
	for (
		let [chord, value] of [
			["ControlOrMeta+b", "go **now**"],
			["ControlOrMeta+b", "go now"],
			["ControlOrMeta+i", "go _now_"],
			["ControlOrMeta+i", "go now"],
			["ControlOrMeta+Shift+x", "go ~~now~~"],
			["ControlOrMeta+Shift+x", "go now"],
			["ControlOrMeta+Shift+c", "go `now`"],
			["ControlOrMeta+Shift+c", "go now"],
			["ControlOrMeta+u", "go now"],
			["ControlOrMeta+Shift+8", "- go now"],
			["ControlOrMeta+Shift+8", "go now"],
			["ControlOrMeta+Shift+7", "1. go now"],
			["ControlOrMeta+Shift+7", "go now"],
			["ControlOrMeta+Alt+Shift+c", "```\ngo now\n```"],
		] as const
	) {
		await draft.press(chord);
		await expectChatValue(draft, value);
	}
	await expect(draft.locator("u")).toHaveCount(0);
});

test("Slack's typed marks format as they close, and Enter sends while Shift+Enter breaks a line", async ({ join, page }) => {
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.click();
	await page.keyboard.type("say *bold* _it_ ~gone~ `x` 2 * 3 * 4 snake_case_name");
	await expect(draft.locator("strong")).toHaveText("bold");
	await expect(draft.locator("em")).toHaveText("it");
	await expect(draft.locator("code")).toHaveText("x");
	await expectChatValue(draft, "say **bold** _it_ ~~gone~~ `x` 2 * 3 * 4 snake_case_name");
	await draft.press("ControlOrMeta+a");
	await draft.press("Backspace");
	await expectChatValue(draft, "");

	await page.keyboard.type("- first");
	await draft.press("Shift+Enter");
	await page.keyboard.type("second");
	await expect(draft.getByRole("listitem")).toHaveText(["first", "second"]);
	// Shift+Enter on an empty item leaves the list.
	await draft.press("Shift+Enter");
	await draft.press("Shift+Enter");
	await page.keyboard.type("then");
	await expectChatValue(draft, "- first\n- second\n\nthen");
	await draft.press("Shift+Enter");
	await page.keyboard.type("1. one");
	await expect(draft.locator("ol").getByRole("listitem")).toHaveText(["one"]);
	await draft.press("Shift+Enter");
	await draft.press("Shift+Enter");
	await page.keyboard.type("```");
	await expect(draft.locator("pre")).toHaveCount(1);
	await page.keyboard.type("a = 1");
	await draft.press("Shift+Enter");
	await page.keyboard.type("b = 2");
	await expectChatValue(draft, "- first\n- second\n\nthen\n1. one\n```\na = 1\nb = 2\n```");
	await draft.press("Enter");
	await expect.poll(() => sent).toEqual([
		"- first\n- second\n\nthen\n1. one\n```\na = 1\nb = 2\n```",
	]);
	await expectChatValue(draft, "");
	let message = chat.locator("[data-chat-markdown]").last();
	await expect(message.getByRole("listitem")).toHaveText(["first", "second", "one"]);
	await expect(message.locator("pre")).toContainText("b = 2");
});

test("a draft comes back after a reload drawn as its formatting, and goes out as the same Markdown", async ({ join, page }) => {
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.fill("ship it now");
	await selectTail(draft, 3);
	await toolbar(chat).getByRole("button", { name: "Bold", exact: true }).click();
	await expectChatValue(draft, "ship it **now**");
	await page.reload();
	let after = chatInput(chatPane(page));
	await expectChatValue(after, "ship it **now**");
	await expect(after.locator("strong")).toHaveText("now");
	await after.press("Enter");
	await expect.poll(() => sent).toEqual(["ship it **now**"]);
	await expect(chatPane(page).getByText("now", { exact: true })).toBeVisible();
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
