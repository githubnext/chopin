import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentSwapLayer } from "./content-swap";

let motion = { className: "motion-content-swap", closeDuration: 250 };

test("an active swap layer is the only exposed interactive frame", () => {
	let markup = renderToStaticMarkup(
		createElement(ContentSwapLayer, {
			active: true,
			children: createElement("button", { type: "button" }, "Current"),
			immediately: true,
			motion,
		}),
	);

	expect(markup).toContain('class="motion-content-swap is-open"');
	expect(markup).not.toContain("aria-hidden");
	expect(markup).not.toContain("inert");
});

test("an inactive layer is hidden, inert, and absent from the accessibility tree", () => {
	let markup = renderToStaticMarkup(
		createElement(ContentSwapLayer, {
			active: false,
			children: createElement("button", { type: "button" }, "Outgoing"),
			immediately: true,
			motion,
		}),
	);

	expect(markup).toContain('aria-hidden="true"');
	expect(markup).toContain(' inert=""');
	expect(markup).toContain(' hidden=""');
});
