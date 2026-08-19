import { describe, expect, it } from "bun:test";

import { adjectives, documentTitle, documentTitles, nouns } from "./document-title";

describe("documentTitle", () => {
	it("draws one curated adjective and noun from an injectable random source", () => {
		expect(adjectives.length).toBeGreaterThanOrEqual(64);
		expect(nouns.length).toBeGreaterThanOrEqual(64);
		expect(documentTitle(() => 0)).toBe(`${adjectives[0]}-${nouns[0]}`);
	});

	it("always returns exactly two lowercase hyphenated words", () => {
		let title = documentTitle(() => 0.999);
		expect(title).toMatch(/^[a-z]+-[a-z]+$/);
		expect(title.split("-")).toHaveLength(2);
	});

	it("walks every candidate after a randomized starting point", () => {
		let titles = documentTitles(() => 0);
		expect(titles.next().value).toBe("amber-anchor");
		expect(titles.next().value).toBe("amber-arch");
		for (let count = 2; count < adjectives.length * nouns.length; count++) titles.next();
		expect(titles.next().done).toBe(true);
	});
});
