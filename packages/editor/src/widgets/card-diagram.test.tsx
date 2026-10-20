import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Diagram } from "./render-blocks";

/** What the drawing is does not matter before it is measured. */
const WIDE = "<p>A drawn flowchart</p>";

test("a card's diagram opens fitted to its frame, and offers its actual size", () => {
	let html = renderToStaticMarkup(<Diagram id="d" html={WIDE} stale={false} fitted />);
	expect(html).toContain('data-fit=""');
	expect(html).toContain("Actual size");
	expect(html).not.toContain("Fit diagram to width");
});

test("a document's diagram still opens at its drawn size, and offers to fit", () => {
	let html = renderToStaticMarkup(<Diagram id="d" html={WIDE} stale={false} />);
	expect(html).not.toContain("data-fit");
	expect(html).toContain("Fit diagram to width");
});
