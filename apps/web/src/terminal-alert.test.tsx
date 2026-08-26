import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TerminalAlert } from "./terminal-alert";

test("terminal alerts own accessible feedback markup", () => {
	let markup = renderToStaticMarkup(
		createElement(TerminalAlert, { className: "surface-error" }, "Could not save"),
	);
	expect(markup).toContain('role="alert"');
	expect(markup).toContain('data-motion-feedback="alert"');
	expect(markup).toContain("motion-feedback");
	expect(markup).toContain("surface-error");
	expect(markup).toContain("Could not save");
});
