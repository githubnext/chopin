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

	test("is on, and not an error, where storage is refused", () => {
		let refusing = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readFormatPreference("ana", refusing)).toBe(true);
		expect(() => keepFormatPreference("ana", false, refusing)).not.toThrow();
	});
});
