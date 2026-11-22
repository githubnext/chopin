/**
 * The browser's `localStorage` and `sessionStorage` for a page that may be refused them, the one
 * way Chopin reaches either (`scripts/check-storage.ts` holds it so; `index.html`'s theme script,
 * which runs before any module, guards its own).
 *
 * A browser that blocks site data (Chrome or Edge with all cookies blocked, Safari's Block all
 * cookies) throws a `SecurityError` from the getter itself, Firefox with storage turned off has
 * none, a damaged profile throws from every call, and a full or private store throws
 * `QuotaExceededError` from a write. Every read and write here is guarded on its own, the getter
 * included, as Excalidraw guards its storage, and nothing here throws. A write the browser refuses
 * is kept for the rest of the page instead, as VS Code for the web keeps its state in memory when
 * the browser's storage can't be opened, so a choice or an unsent message holds as long as the
 * page does and only a reload forgets it. Nothing is said to the person.
 */

export type KeptStorage = {
	/** The value, or null where there is none or storage can't be read. */
	getItem(key: string): string | null;
	/** Whether the browser kept it, so a reload reads it; it holds for this page either way. */
	setItem(key: string, value: string): boolean;
	removeItem(key: string): void;
	/** The keys that hold a value. */
	keys(): string[];
};

function kept(name: "localStorage" | "sessionStorage"): KeptStorage {
	// What the browser refused to write or remove, for this page; null is a removal.
	let page = new Map<string, string | null>();
	// Each access is tried whole: the getter throws where site data is blocked, is null where
	// storage is turned off (which throws on the call), and any call can throw.
	let write = (key: string, value: string | null) => {
		try {
			let storage = globalThis[name];
			if (value === null) storage.removeItem(key);
			else storage.setItem(key, value);
			page.delete(key);
			return true;
		} catch {
			page.set(key, value);
			return false;
		}
	};
	return {
		getItem(key) {
			let held = page.get(key);
			if (held !== undefined) return held;
			try {
				return globalThis[name].getItem(key);
			} catch {
				return null;
			}
		},
		setItem: write,
		removeItem(key) {
			write(key, null);
		},
		keys() {
			let keys = new Set<string>();
			try {
				let storage = globalThis[name];
				for (let index = 0; index < storage.length; index++) keys.add(storage.key(index)!);
			} catch {
				// Only what this page holds.
			}
			for (let [key, value] of page) {
				if (value === null) keys.delete(key);
				else keys.add(key);
			}
			return [...keys];
		},
	};
}

export const safeLocalStorage: KeptStorage = kept("localStorage");
export const safeSessionStorage: KeptStorage = kept("sessionStorage");
