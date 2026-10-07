import { chatCaret, chatInput, expectChatValue } from "./chat-input";
import { seedChildChannel } from "./database";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
}

test("Shift+Tab preserves the draft and sends in persistent Chopin mode after acknowledgement", async ({ join, page }) => {
	await enablePlanner(page);
	let sent: Chat.Send[] = [];
	let release: (() => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") {
					sent.push(frame);
					release = () => server.send(message);
					return;
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let chat = chatPane(await join("ana"));
	let input = chatInput(chat);
	let toggle = chat.getByRole("button", { name: "Talk to Chopin", exact: true });
	await expect(
		chat.locator(".composer-left").getByRole("button", { name: "Talk to Chopin", exact: true }),
	).toHaveCount(1);
	await expect(
		chat.locator(".composer-left").getByRole("button", { name: "Mention docs", exact: true }),
	).toHaveCount(1);
	await expect(
		chat.locator(".composer-actions").getByRole("button", { name: "Send message", exact: true }),
	).toHaveCount(1);
	await expect(chat.locator(".composer-actions > .composer-run-control")).toHaveCount(1);
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await input.fill("Outline export options");
	await input.press("ArrowLeft");
	let caret = await chatCaret(input);
	await input.press("Shift+Tab");
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expectChatValue(input, "Outline export options");
	expect(await chatCaret(input)).toBe(caret);
	await input.evaluate(element => {
		let event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		Object.defineProperty(event, "keyCode", { value: 229 });
		element.dispatchEvent(event);
	});
	await expectChatValue(input, "Outline export options");
	expect(sent).toHaveLength(0);
	await input.press("Enter");
	await expect.poll(() => sent.length).toBe(1);
	expect(sent[0]).toMatchObject({ text: "@chopin Outline export options", to: "planner" });
	await expect(input).toHaveAttribute("contenteditable", "false");
	await expectChatValue(input, "Outline export options");
	await expect(toggle).toBeDisabled();
	release!();
	await expectChatValue(input, "");
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(input).toBeFocused();
	await input.press("Tab");
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	await expect(input).not.toBeFocused();
});

test("document mentions use the actual semibold text for wrapped caret placement, edits and undo", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Export formats\n\nShare a document as Markdown or PDF.\n");
	let target = crypto.randomUUID();
	let title = `Export formats ${target.slice(0, 8)}`;
	await seedChildChannel(Number(new URL(baseURL!).port), room, target, title, "# Export formats\n");
	await enablePlanner(page);
	await page.setViewportSize({ width: 1600, height: 1000 });
	let chat = chatPane(await join("ana"));
	await page.getByRole("separator", { name: "Resize chat", exact: true }).press("Home");
	let input = chatInput(chat);
	await input.fill(`Could you outline the export options? #${target.slice(0, 8)}`);
	let picker = chat.locator("[data-chat-reference-picker]");
	let shadow = await picker.evaluate(element => {
		let probe = document.createElement("span");
		probe.style.boxShadow = "var(--shadow-resting-strong)";
		element.append(probe);
		let expected = getComputedStyle(probe).boxShadow;
		probe.remove();
		return { expected, actual: getComputedStyle(element).boxShadow };
	});
	expect(shadow.actual).toBe(shadow.expected);
	await chat.getByRole("option", { name: title, exact: true }).click();
	let reference = input.locator(".draft-reference");
	await expect(reference).toHaveAttribute("data-document-id", target);
	await expect(reference).toHaveCSS("font-weight", "600");
	await expect(reference).toHaveCSS("text-decoration-line", "underline");
	await expect.poll(() => reference.evaluate(element => element.getClientRects().length))
		.toBeGreaterThan(1);
	let before = await input.textContent();
	await expect.poll(() => chatCaret(input)).toBe(before!.length);
	let caret = await reference.evaluate(element => {
		let walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let last: Node | null = null;
		while (walker.nextNode()) last = walker.currentNode;
		let end = document.createRange();
		end.setStart(last!, last!.textContent!.length);
		end.collapse(true);
		let expected = end.getBoundingClientRect();
		let actual = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
		return {
			expected: { x: expected.x, y: expected.y },
			actual: { x: actual.x, y: actual.y },
			height: actual.height,
		};
	});
	expect(caret.height).toBeGreaterThan(0);
	expect(caret.actual.x).toBeCloseTo(caret.expected.x, 0);
	expect(caret.actual.y).toBeCloseTo(caret.expected.y, 0);
	await input.pressSequentially(" and PDF");
	await expectChatValue(input, before + " and PDF");
	await expect(reference).toHaveAttribute("data-document-id", target);
	await input.press("Meta+z");
	await expectChatValue(input, before!);
	await expect(reference).toHaveAttribute("data-document-id", target);
	await input.press("Meta+Shift+z");
	await expectChatValue(input, before + " and PDF");
	await input.press("Shift+Tab");
	await expectChatValue(input, before + " and PDF");
	await expect.poll(() => chatCaret(input)).toBe(before!.length + 8);
	await input.press("Shift+Enter");
	await page.keyboard.insertText("Keep comments attached.");
	await expectChatValue(input, before + " and PDF\nKeep comments attached.");
	await expect(reference).toHaveAttribute("data-document-id", target);
	let divider = await page.getByRole("separator", { name: "Resize chat", exact: true })
		.boundingBox();
	await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + 20);
	await page.mouse.down();
	await page.mouse.move(divider!.x + divider!.width / 2 + 250, divider!.y + 20, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await chat.boundingBox())!.width).toBeCloseTo(500, 0);
	await page.screenshot({
		path: test.info().outputPath("chopin-composer-production.png"),
		fullPage: true,
	});
	await chat.screenshot({ path: test.info().outputPath("chopin-composer-production-chat.png") });
});

test("read-only and archived notices replace the composer input", async ({ join, page, room }) => {
	let announce: ((frame: Record<string, unknown>) => void) | undefined;
	let hello: Record<string, unknown> | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		announce = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Record<string, unknown>;
				if (frame.kind === "session:hello") hello = frame;
			}
			route.send(message);
		});
	});
	let chat = chatPane(await join("ana"));
	await expect(chatInput(chat)).toBeVisible();
	announce!({ ...hello, canEdit: false, canManage: false });
	await expect(chat.getByText("Read-only access", { exact: true })).toBeVisible();
	await expect(chatInput(chat)).toHaveCount(0);
	let unavailable = chat.locator(".composer-unavailable");
	await expect(unavailable).toHaveCSS("align-items", "center");
	await expect(unavailable).toHaveCSS("justify-content", "center");
	await expect(unavailable.locator("svg")).toHaveCount(1);
	announce!({
		...hello,
		kind: "session:channel",
		channelId: room,
		archivedAt: new Date().toISOString(),
		canManage: false,
	});
	await expect(chat.getByText("Document archived", { exact: true })).toBeVisible();
	await expect(chatInput(chat)).toHaveCount(0);
	await expect(unavailable.locator("svg")).toHaveCount(1);
});

test("switching to Chat removes multiple addresses while preserving a document mention between them", async ({ baseURL, join, page, room }) => {
	let target = crypto.randomUUID();
	let title = `Export @chopin ${target.slice(0, 8)}`;
	await seedChildChannel(Number(new URL(baseURL!).port), room, target, title, "# Export formats\n");
	await enablePlanner(page);
	await page.setViewportSize({ width: 1600, height: 1000 });
	let chat = chatPane(await join("ana"));
	let input = chatInput(chat);
	await input.fill(`@chopin See #${target.slice(0, 8)}`);
	await chat.getByRole("option", { name: title, exact: true }).click();
	await page.keyboard.insertText(" @chopin");
	let reference = input.locator(".draft-reference");
	await expect(reference).toHaveAttribute("data-document-id", target);
	await input.press("Shift+Tab");
	await expect(chat.getByRole("button", { name: "Talk to Chopin", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(reference).toHaveAttribute("data-document-id", target);
	await expect(reference).toHaveText(`#${title}`);
	expect((await input.textContent())!.match(/@chopin/g)).toHaveLength(1);
	await page.keyboard.insertText(" after");
	await expect(reference).toHaveAttribute("data-document-id", target);
});

test("context-menu paste undo restores the replaced native selection", async ({ join, page }) => {
	let input = chatInput(chatPane(await join("ana")));
	await input.fill("hello world");
	await input.evaluate(element => {
		let text = element.firstChild!;
		let range = document.createRange();
		range.setStart(text, 6);
		range.setEnd(text, 11);
		let selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		let clipboardData = new DataTransfer();
		clipboardData.setData("text/plain", "friends");
		clipboardData.setData("text/html", "<strong>friends</strong>");
		element.dispatchEvent(
			new ClipboardEvent("paste", {
				bubbles: true,
				cancelable: true,
				clipboardData,
			}),
		);
	});
	await expectChatValue(input, "hello friends");
	await expect(input.locator("strong")).toHaveCount(0);
	await input.press("Meta+z");
	await expectChatValue(input, "hello world");
	expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("world");
	expect(await chatCaret(input)).toBe(11);
	await input.press("Meta+Shift+z");
	await expectChatValue(input, "hello friends");
});
