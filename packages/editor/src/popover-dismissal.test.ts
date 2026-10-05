import { expect, test } from "bun:test";

import { isOutside } from "./popover-dismissal";

test("a target is outside only when no region contains it", () => {
	let inside = {} as Node;
	let region = { contains: (node: Node) => node === inside };
	expect(isOutside([region], inside)).toBe(false);
	expect(isOutside([null, region], inside)).toBe(false);
	expect(isOutside([region], {} as Node)).toBe(true);
	expect(isOutside([undefined], inside)).toBe(true);
	expect(isOutside([region], null)).toBe(true);
});
