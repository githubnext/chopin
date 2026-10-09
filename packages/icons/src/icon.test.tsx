import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as icons from "./index";

// The web stylesheet holds these markers at their declared size (`flex-shrink: 0`).
test("every icon carries a marker that keeps it from shrinking beside wrapping text", () => {
	for (let [name, Icon] of Object.entries(icons)) {
		let html = renderToStaticMarkup(<Icon />);
		expect(html, name).toMatch(/^<svg[^>]* data-(nucleo|filled)-icon=""/);
	}
});
