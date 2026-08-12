import { expect, test } from "bun:test";

import { containsHit, passageHits } from "./comment-hits";

const host = {
	top: 100,
	right: 500,
	bottom: 500,
	left: 100,
	width: 400,
	height: 400,
};

test("keeps every wrapped passage line as a pointer-transparent hit region", () => {
	let hits = passageHits(host, [
		{ top: 180, right: 420, bottom: 200, left: 180, width: 240, height: 20 },
		{ top: 206, right: 300, bottom: 226, left: 180, width: 120, height: 20 },
	]);

	expect(hits).toEqual([
		{ top: 80, left: 80, width: 240, height: 20 },
		{ top: 106, left: 80, width: 120, height: 20 },
	]);
	expect(containsHit(hits, { top: 116, left: 140 })).toBe(true);
	expect(containsHit(hits, { top: 116, left: 260 })).toBe(false);
});
