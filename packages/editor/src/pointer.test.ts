import { describe, expect, it } from "bun:test";

import {
	hasCoarsePointer,
	isPhone,
	PHONE_SIZE_QUERY,
	PRIMARY_COARSE_POINTER_QUERY,
} from "./pointer";

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

describe("phone class", () => {
	let media = (matches: string[]) => (query: string) => ({ matches: matches.includes(query) });

	it("is a primary touch pointer on a narrow or short screen", () => {
		expect(isPhone(media([PRIMARY_COARSE_POINTER_QUERY, PHONE_SIZE_QUERY]))).toBe(true);
	});

	it("leaves touch tablets and small fine-pointer windows out", () => {
		expect(isPhone(media([PRIMARY_COARSE_POINTER_QUERY]))).toBe(false);
		expect(isPhone(media([PHONE_SIZE_QUERY, "(any-pointer: coarse)"]))).toBe(false);
	});
});
