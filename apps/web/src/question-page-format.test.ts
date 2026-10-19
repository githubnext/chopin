import { expect, test } from "bun:test";

import { dayMonth, settledLine } from "./question-page-format";

let noon = Date.UTC(2026, 9, 19, 12) / 1_000;

test("formats the day before the month", () => {
	expect(dayMonth(noon)).toBe("19 Oct");
});

test("names who settled it without an @ and when", () => {
	expect(settledLine({ resolver: "ada", decidedAt: noon }, handle => `@${handle}`))
		.toBe("Settled by ada, 19 Oct");
	expect(settledLine({ owner: "ben", decidedAt: noon }, () => "Ben")).toBe(
		"Settled by Ben, 19 Oct",
	);
});

test("drops the date or the line when its parts are missing", () => {
	expect(settledLine({ resolver: "ada" }, handle => handle)).toBe("Settled by ada");
	expect(settledLine({ decidedAt: noon }, handle => handle)).toBeUndefined();
});
