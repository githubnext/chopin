import { expect, test } from "bun:test";

import { dayMonth, settledBy } from "./question-page-format";

let noon = Date.UTC(2026, 9, 19, 12) / 1_000;

test("formats the day before the month", () => {
	expect(dayMonth(noon)).toBe("19 Oct");
});

test("names who settled it without an @ and when", () => {
	expect(settledBy({ resolver: "ada", decidedAt: noon }, handle => `@${handle}`))
		.toEqual({ handle: "ada", text: "by ada, 19 Oct" });
	expect(settledBy({ owner: "ben", decidedAt: noon }, () => "Ben")?.text).toBe("by Ben, 19 Oct");
});

test("drops the date or the whole line when its parts are missing", () => {
	expect(settledBy({ resolver: "ada" }, handle => handle)?.text).toBe("by ada");
	expect(settledBy({ decidedAt: noon }, handle => handle)).toBeUndefined();
});
