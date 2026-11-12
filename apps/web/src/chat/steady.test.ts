import { describe, expect, test } from "bun:test";

import { sameFields } from "./steady";

describe("sameFields", () => {
	test("the same values are the same, whatever their functions are", () => {
		let store = {};
		expect(sameFields({ store, connected: true, open: () => 1 }, {
			store,
			connected: true,
			open: () => 2,
		})).toBe(true);
	});

	test("a value that changed, or a field that came or went, is a change", () => {
		let store = {};
		expect(sameFields({ store, connected: true }, { store, connected: false })).toBe(false);
		expect(sameFields({ store }, { store: {} })).toBe(false);
		expect(sameFields({ store }, { store, extra: 1 })).toBe(false);
		expect(sameFields({ store, open: () => 1 }, { store, open: undefined })).toBe(false);
	});

	test("nothing is only the same as nothing", () => {
		expect(sameFields(undefined, undefined)).toBe(true);
		expect(sameFields(undefined, {})).toBe(false);
		expect(sameFields({}, undefined)).toBe(false);
	});
});
