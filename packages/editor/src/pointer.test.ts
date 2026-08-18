import { describe, expect, it } from "bun:test";

import { hasCoarsePointer } from "./pointer";

function hybridMedia(query: string) {
	return { matches: query === "(any-pointer: coarse)" };
}

function fineOnlyMedia() {
	return { matches: false };
}

describe("coarse pointer availability", () => {
	it("recognises touch input when a fine pointer remains primary", () => {
		expect(hasCoarsePointer(hybridMedia)).toBe(true);
	});

	it("does not treat a fine-only device as touch capable", () => {
		expect(hasCoarsePointer(fineOnlyMedia)).toBe(false);
	});
});
