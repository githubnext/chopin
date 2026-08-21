import { describe, expect, it } from "bun:test";

import { documentSlug, documentSlugCandidate, MAX_DOCUMENT_SLUG_LENGTH } from "./slug";

describe("document slugs", () => {
	it("normalizes compatibility characters, case and accents", () => {
		expect(documentSlug("  Café De\u0301jà Vu!  ")).toBe("café-déjà-vu");
		expect(documentSlug("Ｆｕｌｌ　Ｗｉｄｔｈ")).toBe("full-width");
	});

	it("retains non-Latin letters, numbers and combining marks", () => {
		expect(documentSlug("東京 計画 2026")).toBe("東京-計画-2026");
		expect(documentSlug("किताब योजना")).toBe("किताब-योजना");
	});

	it("collapses punctuation and symbols into trimmed hyphens", () => {
		expect(documentSlug("--- Release... readiness / phase #2 ---")).toBe(
			"release-readiness-phase-2",
		);
	});

	it("falls back for a title without letters, numbers or marks", () => {
		expect(documentSlug("🚀 💥 !!!")).toBe("document");
	});

	it("caps slugs by Unicode code point without leaving a trailing hyphen", () => {
		let letter = "𐐨";
		expect(documentSlug("a".repeat(100))).toBe("a".repeat(100));
		expect(documentSlug("a".repeat(101))).toBe("a".repeat(100));
		expect(Array.from(documentSlug(letter.repeat(101)))).toHaveLength(
			MAX_DOCUMENT_SLUG_LENGTH,
		);
		expect(documentSlug(`${"a".repeat(99)} b`)).toBe("a".repeat(99));
	});
});

describe("document slug candidates", () => {
	it("returns the base first and adds numbered suffixes", () => {
		expect(documentSlugCandidate("release-plan", 1)).toBe("release-plan");
		expect(documentSlugCandidate("release-plan", 2)).toBe("release-plan-2");
		expect(documentSlugCandidate("release-plan", 12)).toBe("release-plan-12");
	});

	it("truncates the base to keep the suffix within the limit", () => {
		let base = "𐐨".repeat(MAX_DOCUMENT_SLUG_LENGTH);
		let candidate = documentSlugCandidate(base, 12);
		expect(Array.from(candidate)).toHaveLength(MAX_DOCUMENT_SLUG_LENGTH);
		expect(candidate).toBe(`${"𐐨".repeat(97)}-12`);

		let hyphenBoundary = `${"a".repeat(97)}-bc`;
		expect(documentSlugCandidate(hyphenBoundary, 2)).toBe(`${"a".repeat(97)}-2`);
	});

	it("rejects nonsensical candidate indexes", () => {
		for (let index of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(() => documentSlugCandidate("release-plan", index)).toThrow(RangeError);
		}
	});
});
