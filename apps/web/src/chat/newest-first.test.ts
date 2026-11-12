import { expect, test } from "bun:test";

import { arrivedInBulk, earlierRows, FIRST_MESSAGES, newestRows } from "./newest-first";

test("the newest rows hold the first messages, whole rows only", () => {
	let sizes = Array.from({ length: 200 }, (_, index) => index % 2 ? 1 : 3);
	let from = newestRows(sizes, FIRST_MESSAGES);
	let held = sizes.slice(from).reduce((a, b) => a + b, 0);
	expect(held).toBeGreaterThanOrEqual(FIRST_MESSAGES);
	expect(held - sizes[from]!).toBeLessThan(FIRST_MESSAGES);
	expect(newestRows([2, 2], FIRST_MESSAGES)).toBe(0);
});

test("a 400-message history is mounted newest first, a step of whole rows at a time", () => {
	let sizes = Array.from({ length: 400 }, () => 1);
	let steps = [newestRows(sizes, FIRST_MESSAGES)];
	while (steps.at(-1)! > 0) steps.push(earlierRows(sizes, steps.at(-1)!));
	expect(steps.map(from => 400 - from)).toEqual([30, 90, 150, 210, 270, 330, 390, 400]);
});

test("a live message is not a bulk arrival; a history is", () => {
	expect(arrivedInBulk(1)).toBe(false);
	expect(arrivedInBulk(400)).toBe(true);
});
