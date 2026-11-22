/** Whether a person keeps the formatting toolbar on: kept per person in this browser, on by default. */

import { safeLocalStorage } from "@chopin/editor/browser-storage";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const key = (handle: string) => `chopin:chat-formatting:${handle}`;

export function readFormatPreference(handle: string, storage: Storage = safeLocalStorage): boolean {
	return storage.getItem(key(handle)) !== "off";
}

export function keepFormatPreference(
	handle: string,
	on: boolean,
	storage: Storage = safeLocalStorage,
): void {
	storage.setItem(key(handle), on ? "on" : "off");
}
