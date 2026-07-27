import { describe, expect, it } from "bun:test";

import { assert } from "./validate";
import { parse } from "./parse";
import { ULID, ulid } from "./ulid";

describe("ulid", () => {
	it("produces something the validator accepts", () => {
		for (let i = 0; i < 200; i++) expect(ULID.test(ulid())).toBe(true);
	});

	/**
	 * The generator and the validator are the two halves of one contract, and
	 * the expensive way to discover they disagree is a rejected update batch.
	 */
	it("produces ids the dialect accepts in a real document", () => {
		let source = `<Callout id="${ulid()}" type="note">\n\tText.\n</Callout>\n`;
		expect(() => assert(parse(source))).not.toThrow();
	});

	it("sorts by creation time", () => {
		let early = ulid(1_700_000_000_000);
		let late = ulid(1_700_000_001_000);
		expect(early < late).toBe(true);
	});

	it("does not collide within a millisecond", () => {
		let now = Date.now();
		let seen = new Set(Array.from({ length: 1000 }, () => ulid(now)));
		expect(seen.size).toBe(1000);
	});
});
