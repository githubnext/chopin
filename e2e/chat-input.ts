import { expect } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

export function chatInput(scope: Locator | Page): Locator {
	return scope.getByRole("combobox", { name: "Message", exact: true, includeHidden: true });
}

/**
 * The draft's value is the Markdown it will be sent as, which the rich draft keeps on its field as
 * `data-chat-raw` (its text is what the formatting draws, without its marks).
 */
export async function chatValue(input: Locator): Promise<string | null> {
	return input.getAttribute("data-chat-raw");
}

export async function expectChatValue(input: Locator, value: string): Promise<void> {
	await expect.poll(() => chatValue(input)).toBe(value);
}

export async function fillChat(input: Locator, value: string): Promise<void> {
	let [first, ...lines] = value.split("\n");
	await input.fill(first ?? "");
	for (let line of lines) {
		await input.press("Shift+Enter");
		await input.page().keyboard.insertText(line);
	}
}

export async function chatCaret(input: Locator): Promise<number> {
	return input.evaluate(element => {
		let selection = window.getSelection();
		if (!selection?.rangeCount || !element.contains(selection.focusNode)) return -1;
		let range = document.createRange();
		range.selectNodeContents(element);
		range.setEnd(selection.focusNode!, selection.focusOffset);
		return range.toString().length;
	});
}
