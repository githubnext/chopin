import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Count } from "./count";

test("count motion is explicit rather than progress-wide", () => {
	let quiet = renderToStaticMarkup(createElement(Count, null, 2));
	let entering = renderToStaticMarkup(createElement(Count, { children: 2, motion: true }));

	expect(quiet).not.toContain("motion-feedback");
	expect(quiet).not.toContain("editor-motion-feedback");
	expect(quiet).not.toContain("data-motion-settled");
	expect(entering).toContain("editor-motion-feedback");
	expect(entering).toContain('data-motion-feedback="count"');
	expect(entering).not.toContain("data-motion-settled");
});
