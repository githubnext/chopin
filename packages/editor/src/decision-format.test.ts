import { describe, expect, it } from "bun:test";

import { decidedOn, discussionLine } from "./decision-format";

describe("decidedOn", () => {
	it("uses the Figma local-time format", () => {
		let at = new Date(2026, 8, 23, 17, 30).getTime() / 1_000;
		expect(decidedOn(at)).toBe("Decided on Sep 23rd, 5:30pm");
	});

	it("uses the right ordinal for single digits, teens, and twenties", () => {
		let day = (date: number) => decidedOn(new Date(2026, 0, date, 9, 5).getTime() / 1_000);
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(day)).toEqual([
			"Decided on Jan 1st, 9:05am",
			"Decided on Jan 2nd, 9:05am",
			"Decided on Jan 3rd, 9:05am",
			"Decided on Jan 4th, 9:05am",
			"Decided on Jan 11th, 9:05am",
			"Decided on Jan 12th, 9:05am",
			"Decided on Jan 13th, 9:05am",
			"Decided on Jan 21st, 9:05am",
			"Decided on Jan 22nd, 9:05am",
		]);
	});
});

describe("discussionLine", () => {
	it("names the owner first and each other person once", () => {
		expect(discussionLine("luna", ["luna"])).toBe("By luna");
		expect(discussionLine("luna", ["luna", "maria"])).toBe(
			"By luna, in discussion with maria",
		);
		expect(discussionLine("luna", ["maria", "luna", "tom", "sam", "tom"]))
			.toBe("By luna, in discussion with maria, tom and sam");
	});
});
