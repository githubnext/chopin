/** Whether a person keeps the formatting toolbar on: kept per person in this browser, on by default. */

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const key = (handle: string) => `chopin:chat-formatting:${handle}`;

export function readFormatPreference(handle: string, storage?: Storage): boolean {
	try {
		return (storage ?? localStorage).getItem(key(handle)) !== "off";
	} catch {
		// Private windows and blocked storage: it is on, as it is for anybody who never chose.
		return true;
	}
}

export function keepFormatPreference(handle: string, on: boolean, storage?: Storage): void {
	try {
		(storage ?? localStorage).setItem(key(handle), on ? "on" : "off");
	} catch {
		// Not kept; it holds until the page is closed.
	}
}
