/** What the specs of files in Chat share: a picture, a chat pane and the ways to add a file. */
import { chatInput } from "./chat-input";

import type { Locator, Page } from "@playwright/test";

/** A 2x2 PNG that draws, so a thumbnail has something to show. */
export const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=",
	"base64",
);

export const NOTES = {
	name: "notes.md",
	mimeType: "text/markdown",
	buffer: Buffer.from("# Notes\n\nThe cap is 100.\n"),
};

export const SHOT = { name: "shot.png", mimeType: "image/png", buffer: PNG };

export function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

export function composer(page: Page): Locator {
	return chat(page).locator(".chat-composer");
}

/** The files waiting in the composer, above the field. */
export function strip(page: Page): Locator {
	return composer(page).getByRole("list", { name: "Files to send" });
}

export function chip(page: Page, name: string): Locator {
	return strip(page).getByRole("listitem").filter({ hasText: name });
}

/** The `+` in the bottom row, which opens the picker. */
export function plus(page: Page): Locator {
	return composer(page).getByRole("button", { name: "Add files", exact: true });
}

/** Choose files the way the picker does. */
export async function choose(
	page: Page,
	...files: Array<{ name: string; mimeType: string; buffer: Buffer }>
): Promise<void> {
	await composer(page).locator("[data-chat-file-input]").setInputFiles(files);
}

type Dropped = { name: string; type: string; base64: string };

function encode(files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Dropped[] {
	return files.map(file => ({
		name: file.name,
		type: file.mimeType,
		base64: file.buffer.toString("base64"),
	}));
}

/** Drag files over the composer and drop them, as a pointer would. */
export async function drop(
	page: Page,
	files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
	options: { over?: boolean } = {},
): Promise<void> {
	let target = composer(page).locator(".composer-surface");
	let transfer = await target.evaluateHandle((_, dropped) => {
		let data = new DataTransfer();
		for (let file of dropped) {
			let bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
			data.items.add(new File([bytes], file.name, { type: file.type }));
		}
		return data;
	}, encode(files));
	await target.dispatchEvent("dragenter", { dataTransfer: transfer });
	await target.dispatchEvent("dragover", { dataTransfer: transfer });
	if (options.over) return;
	await target.dispatchEvent("drop", { dataTransfer: transfer });
}

/**
 * Leave where the drag was, with the files still in it: for another element inside the composer when
 * `into` names one (moving between its own parts), and for none at all, outside it, otherwise.
 */
export async function leave(page: Page, into?: string): Promise<void> {
	let target = composer(page).locator(".composer-surface");
	let transfer = await target.evaluateHandle(() => {
		let data = new DataTransfer();
		data.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
		return data;
	});
	await target.evaluate(
		(element, { data, selector }) => {
			element.dispatchEvent(
				new DragEvent("dragleave", {
					dataTransfer: data,
					relatedTarget: selector ? element.querySelector(selector) : null,
					bubbles: true,
				}),
			);
		},
		{ data: transfer, selector: into },
	);
}

/** Paste files into the field, as a copied screenshot or a copied file does. */
export async function paste(
	page: Page,
	files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
	text?: string,
): Promise<void> {
	let field = chatInput(chat(page));
	await field.focus();
	await field.evaluate((element, pasted) => {
		let data = new DataTransfer();
		for (let file of pasted.files) {
			let bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
			data.items.add(new File([bytes], file.name, { type: file.type }));
		}
		if (pasted.text) data.setData("text/plain", pasted.text);
		element.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
		);
	}, { files: encode(files), text });
}
