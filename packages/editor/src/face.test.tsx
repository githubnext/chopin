import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Face } from "./face";

test("an overlapping header face uses the header surface for its cover ring", () => {
	let markup = renderToStaticMarkup(
		createElement(Face, { handle: "maggie", ring: "ground" }),
	);

	expect(markup).toContain("ring-2 ring-ground");
});
