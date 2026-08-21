import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Face, FACE_RING_CLASS } from "./face";

test("names static cover-ring classes for every supported surface", () => {
	expect(FACE_RING_CLASS).toEqual({
		ground: "ring-2 ring-ground",
		page: "ring-2 ring-page",
	});
});

test("an overlapping header face uses the header surface for its cover ring", () => {
	let markup = renderToStaticMarkup(
		createElement(Face, { handle: "maggie", ring: "ground" }),
	);

	expect(markup).toContain("ring-2 ring-ground");
});
