/**
 * Saying who settled something, and when.
 *
 * The two records keep the moment in different shapes — a comment thread in
 * Unix seconds, a questionnaire in the ISO string the plan carries — because
 * one is read off the wire and the other out of the document. The card should
 * not care, and a reader should not be able to tell which they are looking at.
 *
 * Only the formatting is tested. What the card looks like is layout, and
 * happy-dom returns zero for every measurement.
 */

import { describe, expect, it } from "bun:test";

import { when } from "./card";

describe("saying when", () => {
	it("reads a comment's seconds and a questionnaire's ISO string the same way", () => {
		let seconds = Date.UTC(2026, 6, 28, 10, 14) / 1_000;
		let iso = new Date(seconds * 1_000).toISOString();

		expect(when(seconds)).toBe(when(iso));
	});

	it("says the month, the day and the time", () => {
		let stamp = when(Date.UTC(2026, 6, 28, 10, 14) / 1_000);

		expect(stamp).toContain("28");
		expect(stamp).toMatch(/\d{1,2}:\d{2}/);
	});

	/**
	 * A record written before this was recorded has nothing to say. Rendering
	 * "Invalid Date" beside a decision would be worse than saying nothing.
	 */
	it("says nothing rather than something wrong", () => {
		expect(when("")).toBe("");
		expect(when("not a date")).toBe("");
		expect(when(Number.NaN)).toBe("");
	});
});
