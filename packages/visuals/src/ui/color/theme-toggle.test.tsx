import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThemeToggle } from "./theme-toggle";

test("theme toggle exposes its choice as a pressed button group", () => {
	let markup = renderToStaticMarkup(createElement(ThemeToggle, { value: "dark", onChange() {} }));
	expect(markup).toContain('role="group"');
	expect(markup).toContain('aria-label="Theme"');
	expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Light<\/button>/);
	expect(markup).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Dark<\/button>/);
});
