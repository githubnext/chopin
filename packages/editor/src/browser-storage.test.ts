import { afterEach, describe, expect, test } from "bun:test";

import { safeLocalStorage, safeSessionStorage } from "./browser-storage";

type Name = "localStorage" | "sessionStorage";
type Operation = "getItem" | "setItem" | "removeItem" | "key";

/** A browser's storage, which can be made to throw from any of its operations. */
class Browser implements Storage {
	values = new Map<string, string>();
	constructor(private refusing: Partial<Record<Operation, () => never>> = {}) {}
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		this.refusing.getItem?.();
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		this.refusing.key?.();
		return [...this.values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.refusing.removeItem?.();
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		this.refusing.setItem?.();
		this.values.set(key, value);
	}
}

function refuse(name: string, message: string): () => never {
	return () => {
		throw new DOMException(message, name);
	};
}

let insecure = refuse("SecurityError", "The operation is insecure.");
let full = refuse("QuotaExceededError", "The quota has been exceeded.");
// Firefox throws this, not a DOMException, from a profile whose storage is damaged.
let corrupted = () => {
	throw Object.assign(new Error("NS_ERROR_FILE_CORRUPTED"), { name: "NS_ERROR_FILE_CORRUPTED" });
};

const STORES = [
	["localStorage", safeLocalStorage],
	["sessionStorage", safeSessionStorage],
] as const;

let originals = new Map(
	STORES.map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

afterEach(() => {
	for (let [name, original] of originals) {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	}
});

function install(name: Name, storage: Storage | null) {
	Object.defineProperty(globalThis, name, { configurable: true, value: storage });
}

/** Each way a browser refuses storage, as the page meets it. */
const REFUSALS: [string, (name: Name) => void][] = [
	[
		"refuses the storage itself, as Chrome and Edge do with site data blocked",
		name =>
			Object.defineProperty(globalThis, name, {
				configurable: true,
				get: () => insecure(),
			}),
	],
	["has none, as Firefox with storage turned off", name => install(name, null)],
	[
		"throws on every call, as a damaged profile does",
		name =>
			install(
				name,
				new Browser({
					getItem: corrupted,
					setItem: corrupted,
					removeItem: corrupted,
					key: corrupted,
				}),
			),
	],
	[
		"keeps nothing over its quota, as Safari's private windows did",
		name => install(name, new Browser({ setItem: full, removeItem: full })),
	],
];

function key() {
	return `chopin:test:${crypto.randomUUID()}`;
}

describe.each(STORES)("%s", (name, store) => {
	describe.each(REFUSALS)("where the browser %s", (_, refusing) => {
		test("reads what was never kept as nothing, without throwing", () => {
			refusing(name);
			let k = key();
			expect(store.getItem(k)).toBeNull();
			expect(store.keys()).not.toContain(k);
		});

		test("keeps a write for the page's life and says the browser didn't keep it", () => {
			refusing(name);
			let k = key();
			expect(store.setItem(k, "wide")).toBe(false);
			expect(store.getItem(k)).toBe("wide");
			expect(store.setItem(k, "narrow")).toBe(false);
			expect(store.getItem(k)).toBe("narrow");
			expect(store.keys()).toContain(k);
		});

		test("forgets a removal for the page's life too", () => {
			refusing(name);
			let k = key();
			store.setItem(k, "draft");
			expect(() => store.removeItem(k)).not.toThrow();
			expect(store.getItem(k)).toBeNull();
			expect(store.keys()).not.toContain(k);
		});
	});

	describe("where the browser keeps it", () => {
		test("writes to the browser's storage and says so", () => {
			let browser = new Browser();
			install(name, browser);
			let k = key();
			expect(store.setItem(k, "on")).toBe(true);
			expect(browser.values.get(k)).toBe("on");
			store.removeItem(k);
			expect(browser.values.has(k)).toBe(false);
		});

		test("reads what another tab or an earlier page kept", () => {
			let browser = new Browser();
			install(name, browser);
			let k = key();
			browser.values.set(k, "dark");
			expect(store.getItem(k)).toBe("dark");
			browser.values.set(k, "light");
			expect(store.getItem(k)).toBe("light");
			expect(store.keys()).toContain(k);
		});

		test("reads a removal the browser refused as nothing, though the value is still kept", () => {
			let browser = new Browser({ removeItem: full });
			install(name, browser);
			let k = key();
			browser.values.set(k, "kept");
			store.removeItem(k);
			expect(store.getItem(k)).toBeNull();
			expect(store.keys()).not.toContain(k);
		});

		test("reads a write the browser refused over the older value it still holds", () => {
			let browser = new Browser({ setItem: full });
			install(name, browser);
			let k = key();
			browser.values.set(k, "320");
			expect(store.setItem(k, "480")).toBe(false);
			expect(store.getItem(k)).toBe("480");
			expect(store.keys().filter(item => item === k)).toEqual([k]);
		});
	});
});

test("the two storages are kept apart", () => {
	install("localStorage", null);
	install("sessionStorage", null);
	let k = key();
	safeLocalStorage.setItem(k, "local");
	expect(safeSessionStorage.getItem(k)).toBeNull();
});
