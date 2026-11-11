import { chatCaret, chatInput, expectChatValue, fillChat } from "./chat-input";
import { seedChildChannel } from "./database";
import { authenticate, expect, roomPath, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

test("touch chat input stays at least 16px to avoid focus zoom", async ({ join }) => {
	let page = await join("ana", { hasTouch: true, viewport: { width: 390, height: 844 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	let input = chatInput(chatPane(page));
	await expect(input).toBeVisible();
	await input.focus();
	let size = await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
	expect(size).toBeGreaterThanOrEqual(16);
});

for (let touch of [false, true]) {
	test(`chat input rests at ${touch ? "one line" : "two lines"} and grows to its cap on ${touch ? "a touch phone" : "desktop"}`, async ({ join }) => {
		let page = await join("ana", {
			hasTouch: touch,
			viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		});
		if (touch) {
			await page.getByRole("navigation", { name: "Workspace view" })
				.getByRole("button", { name: /^Chat/ }).click();
		}
		let input = chatInput(chatPane(page));
		await expect(input).toBeVisible();
		// The field the draft sits in is what is capped and scrolls, so the Chopin chip that floats at
		// the start of the draft goes with the first line.
		let field = input.locator("xpath=..");
		let initial = await input.evaluate(element => {
			let style = getComputedStyle(element);
			return {
				height: element.getBoundingClientRect().height,
				line: parseFloat(style.lineHeight),
				padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
				maximum: parseFloat(getComputedStyle(element.parentElement!).maxHeight),
			};
		});
		// A phone's pill composer rests at one line; desktop keeps room for two.
		expect(initial.height).toBeCloseTo(initial.padding + (touch ? 1 : 2) * initial.line, 0);
		await fillChat(input, "One\nTwo\nThree\nFour");
		await expect.poll(() => input.evaluate(element => element.getBoundingClientRect().height))
			.toBeGreaterThan(initial.height);
		await fillChat(input, Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n"));
		await expect.poll(() => field.evaluate(element => element.getBoundingClientRect().height))
			.toBeCloseTo(initial.maximum, 0);
		expect(await field.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	});
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
}

test("Control+J preserves the draft and sends with the chip, which stays on after acknowledgement", async ({ join, page }) => {
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
	let chip = chat.getByRole("group", { name: "Asking Chopin", exact: true });
	let remove = chat.getByRole("button", { name: "Remove Chopin", exact: true });
	await expect(chip).toHaveCount(0);
	await input.fill("Outline export options");
	await input.press("ArrowLeft");
	let caret = await chatCaret(input);
	await input.press("ControlOrMeta+j");
	await expect(chip).toBeVisible();
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
	// The message is in the Chat at once, waiting to send, and the composer is empty and free for
	// the next one, with the chip still on: nothing waits on the acknowledgement.
	let outline = chat.locator("[data-chat-message-id]").filter({
		hasText: "Outline export options",
	});
	await expect(outline).toHaveCount(1);
	await expect(outline.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expect(input).toHaveAttribute("contenteditable", "true");
	await expectChatValue(input, "");
	await expect(remove).toBeEnabled();
	await expect(chip).toBeVisible();
	release!();
	await expect(outline.getByRole("img", { name: "Waiting to send" })).toHaveCount(0);
	await expect(outline).toHaveCount(1);
	await expectChatValue(input, "");
	await expect(chip).toBeVisible();
	await expect(input).toBeFocused();
	await input.press("Tab");
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	await expect(input).not.toBeFocused();
});

test("wrapped document mentions keep caret placement, edits and undo aligned", async ({ baseURL, join, page, room, seed }) => {
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
	await chat.getByRole("option", { name: title, exact: true }).click();
	let reference = input.locator(".draft-reference");
	await expect(reference).toHaveAttribute("data-document-id", target);
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
	await input.press("ControlOrMeta+j");
	await expectChatValue(input, before + " and PDF");
	await expect.poll(() => chatCaret(input)).toBe(before!.length + 8);
	await input.press("Shift+Enter");
	await page.keyboard.insertText("Keep comments attached.");
	await expectChatValue(input, before + " and PDF\nKeep comments attached.");
	await expect(reference).toHaveAttribute("data-document-id", target);
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
	await expect(chat.getByText("You have read-only access to this document.", { exact: true }))
		.toBeVisible();
	await expect(chatInput(chat)).toHaveCount(0);
	announce!({
		...hello,
		kind: "session:channel",
		channelId: room,
		archivedAt: new Date().toISOString(),
		updatedAt: new Date(Date.now() + 1000).toISOString(),
		canManage: true,
	});
	await expect(chat.getByText("Archived. Restore it to keep chatting.", { exact: true }))
		.toBeVisible();
	await expect(chatInput(chat)).toHaveCount(0);
});

test("removing the chip removes multiple addresses while preserving a document mention between them", async ({ baseURL, join, page, room }) => {
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
	await chat.getByRole("button", { name: "Remove Chopin", exact: true }).click();
	await expect(chat.getByRole("group", { name: "Asking Chopin", exact: true })).toHaveCount(0);
	await expect(reference).toHaveAttribute("data-document-id", target);
	await expect(reference).toHaveText(`#${title}`);
	expect((await input.textContent())!.match(/@chopin/g)).toHaveLength(1);
	await page.keyboard.insertText(" after");
	await expect(reference).toHaveAttribute("data-document-id", target);
});

test("a sent message keeps its nested list nested", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let input = chatInput(chat);
	await fillChat(input, "Plan:\n\n- parent\n  - child\n    - grandchild\n- next");
	await input.press("Enter");

	let message = chat.locator("[data-chat-markdown]").filter({ hasText: "grandchild" });
	let parent = message.getByRole("listitem").filter({ hasText: "parent" }).first();
	let child = parent.getByRole("list").getByRole("listitem").filter({ hasText: "child" }).first();
	let grandchild = child.getByRole("list").getByRole("listitem").filter({ hasText: "grandchild" });
	await expect(grandchild).toHaveCount(1);
	await expect(message.getByRole("listitem").filter({ hasText: "next" }).last())
		.not.toContainText("child");
	let left = async (item: typeof parent) => (await item.boundingBox())!.x;
	expect(await left(child)).toBeGreaterThan(await left(parent));
	expect(await left(grandchild)).toBeGreaterThan(await left(child));
});

test(
	"a sent message keeps numbered items after a lead-in line as a list",
	async ({ join }, testInfo) => {
		let chat = chatPane(await join("ana"));
		let input = chatInput(chat);
		await fillChat(
			input,
			"Start now:\n1. `prove-core`: prove it.\n2. `add-tests`: add tests.\n\nNeeds task 1 first:\n3. `rewire`: rewire the handler.\n\nNeed task 3 first:\n4. `table-tests`: check tables.\n5. `secret-test`: check the secret.",
		);
		await input.press("Enter");

		let message = chat.locator("[data-chat-markdown]").filter({ hasText: "secret-test" });
		await expect(message).toBeVisible();
		let screenshot = testInfo.outputPath("numbered-continuation.png");
		await message.screenshot({ path: screenshot });
		await testInfo.attach("numbered-continuation", { path: screenshot, contentType: "image/png" });
		await expect(message.locator("ol")).toHaveCount(3);
		await expect(message.locator("ol").nth(1)).toHaveAttribute("start", "3");
		await expect(message.locator("ol").nth(2).getByRole("listitem")).toHaveText([
			"table-tests: check tables.",
			"secret-test: check the secret.",
		]);
		await expect(message.locator("p")).toHaveText([
			"Start now:",
			"Needs task 1 first:",
			"Need task 3 first:",
		]);
	},
);

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

test("copied assistant-ui stylesheet stays off non-document pages and is applied before the first copied element mounts", async ({ baseURL, page, room }) => {
	await enablePlanner(page);
	await authenticate(page, "ana", baseURL!);
	await page.goto("/machines");
	await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();

	let initialStylesheets = await page.evaluate(() =>
		[...document.styleSheets].map(sheet => sheet.href ?? "")
	);
	expect(initialStylesheets.some(href => /\/assets\/index-[\w-]+\.css$/.test(href))).toBe(true);
	expect(initialStylesheets.some(href => /\/assets\/assistant-ui-[\w-]+\.css$/.test(href))).toBe(
		false,
	);
	expect(
		await page.evaluate(() =>
			performance.getEntriesByType("resource").some(entry =>
				/\/assets\/assistant-ui-[\w-]+\.css$/.test(new URL(entry.name).pathname)
			)
		),
	).toBe(false);

	await page.addInitScript(() => {
		let recorded = false;
		new MutationObserver(() => {
			if (recorded) return;
			let copy = document.querySelector<HTMLElement>(
				'[data-slot="composer-voice-button"], [data-slot="directive-text-chip"], [data-slot="model-selector-trigger"]',
			);
			if (!copy) return;
			recorded = true;
			let style = getComputedStyle(copy);
			(window as unknown as {
				__firstCopyPaint?: {
					assistantUiLoaded: boolean;
					fontSize: string;
					height: number;
					slot: string | null;
				};
			}).__firstCopyPaint = {
				assistantUiLoaded: [...document.styleSheets].some(sheet =>
					/\/assets\/assistant-ui-[\w-]+\.css$/.test(sheet.href ?? "")
				),
				fontSize: style.fontSize,
				height: copy.getBoundingClientRect().height,
				slot: copy.getAttribute("data-slot"),
			};
		}).observe(document, { childList: true, subtree: true });
	});

	await page.goto(roomPath(room));
	let chat = chatPane(page);
	let input = chatInput(chat);
	await expect(input).toBeVisible();
	await input.focus();
	await input.press("ControlOrMeta+j");
	await expect(chat.locator('[data-slot="directive-text-chip"]')).toBeVisible();

	let firstCopy = await page.evaluate(() =>
		(window as unknown as {
			__firstCopyPaint?: {
				assistantUiLoaded: boolean;
				fontSize: string;
				height: number;
				slot: string | null;
			};
		}).__firstCopyPaint
	);
	expect(firstCopy).toBeDefined();
	expect(firstCopy?.assistantUiLoaded).toBe(true);
	expect(firstCopy?.height).toBeGreaterThan(0);
	if (firstCopy?.slot === "directive-text-chip") expect(firstCopy.fontSize).toBe("12px");
});
