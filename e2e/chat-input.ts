import { expect } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

export function chatInput(scope: Locator | Page): Locator {
	return scope.getByRole("combobox", { name: "Message", exact: true, includeHidden: true });
}

export async function expectChatValue(input: Locator, value: string): Promise<void> {
	await expect.poll(() => input.textContent()).toBe(value);
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
