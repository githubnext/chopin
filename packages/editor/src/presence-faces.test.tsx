import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PresenceFaces, presenceSplit, withoutSelf } from "./presence-faces";

test("dedupes by handle and keeps three faces, the rest counted", () => {
	let split = presenceSplit(["a", "B", "b", "c", "d", "e"]);
	expect(split.shown).toEqual(["a", "B", "c"]);
	expect(split.hidden).toEqual(["d", "e"]);
});

test("tooltips keep handle casing and list hidden handles", () => {
	let markup = renderToStaticMarkup(
		createElement(PresenceFaces, { handles: ["MaggieAppleton", "b", "c", "Dee", "eve"] }),
	);
	expect(markup).toContain('data-tooltip="MaggieAppleton"');
	expect(markup).toContain('data-tooltip="Dee, eve"');
	expect(markup).toContain("+2");
	expect(markup).not.toContain("title=");
});

test("renders nothing with nobody present", () => {
	expect(renderToStaticMarkup(createElement(PresenceFaces, { handles: [] }))).toBe("");
});

test("the viewer is never shown as present, whatever the casing", () => {
	expect(withoutSelf(["Ana", "bo", "ANA"], "ana")).toEqual(["bo"]);
	expect(withoutSelf(["ana", "bo"])).toEqual(["ana", "bo"]);
});
