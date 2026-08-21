import { describe, expect, it } from "bun:test";

import { visibleOutlineColor } from "./focus-color";

describe("visibleOutlineColor", () => {
	it("rejects transparent computed outline colours", () => {
		expect(visibleOutlineColor("transparent")).toBe(false);
		expect(visibleOutlineColor("rgba(0, 0, 0, 0)")).toBe(false);
		expect(visibleOutlineColor("rgb(0 0 0 / 0)")).toBe(false);
		expect(visibleOutlineColor("oklch(0.5 0.1 200 / 0%)")).toBe(false);
	});

	it("accepts opaque and translucent computed outline colours", () => {
		expect(visibleOutlineColor("rgb(0, 120, 130)")).toBe(true);
		expect(visibleOutlineColor("rgba(0, 120, 130, 0.5)")).toBe(true);
		expect(visibleOutlineColor("oklch(0.5 0.1 200)")).toBe(true);
	});
});
