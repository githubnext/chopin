import { describe, expect, test } from "bun:test";

import { keepFormatPreference, readFormatPreference } from "./format-preference";

function storage(held: Record<string, string> = {}) {
	return {
		getItem: (key: string) => held[key] ?? null,
		setItem: (key: string, value: string) => void (held[key] = value),
	};
}

describe("the formatting toolbar's preference", () => {
	test("is on for somebody who never chose", () => {
		expect(readFormatPreference("ana", storage())).toBe(true);
	});

	test("is kept for the person who turned it off, and for nobody else", () => {
		let held = storage();
		keepFormatPreference("ana", false, held);
		expect(readFormatPreference("ana", held)).toBe(false);
		expect(readFormatPreference("cy", held)).toBe(true);
		keepFormatPreference("ana", true, held);
		expect(readFormatPreference("ana", held)).toBe(true);
	});

	test("is on, and not an error, where the browser refuses storage, and holds for the page", () => {
		let original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get: () => {
				throw new DOMException("Access is denied for this document.", "SecurityError");
			},
		});
		try {
			expect(readFormatPreference("bo")).toBe(true);
			expect(() => keepFormatPreference("bo", false)).not.toThrow();
			expect(readFormatPreference("bo")).toBe(false);
		} finally {
			if (original) Object.defineProperty(globalThis, "localStorage", original);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	});
});
