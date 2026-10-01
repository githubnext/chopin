import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Face, FACE_RADIUS_CLASS, FACE_RING_CLASS, faceCorner } from "./face";

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

test("corner radius scales with size", () => {
	expect(FACE_RADIUS_CLASS[faceCorner(18)]).toBe("rounded-sm");
	expect(FACE_RADIUS_CLASS[faceCorner(24)]).toBe("rounded-md");
});

test("a named tooltip suppresses the native title", () => {
	let titled = renderToStaticMarkup(createElement(Face, { handle: "maggie" }));
	let quiet = renderToStaticMarkup(createElement(Face, { handle: "maggie", titled: false }));
	expect(titled).toContain('title="maggie"');
	expect(quiet).not.toContain("title=");
});
