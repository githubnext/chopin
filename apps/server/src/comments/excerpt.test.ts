import { describe, expect, it } from "bun:test";

import { excerpt } from "./service";

describe("excerpt", () => {
	it("keeps a short passage whole", () => {
		expect(excerpt("  a   short\npassage ")).toBe("a short passage");
	});

	it("cuts a long passage at a word boundary and marks the cut", () => {
		let value = excerpt(
			"The rollout should reach a shared staging environment before anyone depends on it.",
		);
		expect(value).toBe("The rollout should reach a shared staging environment before…");
	});

	it("drops a word the limit would split, even when it is the last one", () => {
		let text = `${"a".repeat(59)} next`;
		expect(excerpt(text)).toBe(`${"a".repeat(59)}…`);
	});

	it("keeps the whole word that ends exactly at the limit", () => {
		let text = `${"a".repeat(30)} ${"b".repeat(29)} next`;
		expect(text[60]).toBe(" ");
		expect(excerpt(text)).toBe(`${"a".repeat(30)} ${"b".repeat(29)}…`);
	});

	it("falls back to a hard cut when there is no usable boundary", () => {
		expect(excerpt("x".repeat(100))).toBe(`${"x".repeat(60)}…`);
	});
});
