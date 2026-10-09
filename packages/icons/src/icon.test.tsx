import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import * as icons from "./index";

// The web stylesheet holds these markers at their declared size (`flex-shrink: 0`).
test("every icon carries a marker that keeps it from shrinking beside wrapping text", () => {
	for (let [name, Icon] of Object.entries(icons)) {
		if (typeof Icon !== "function") continue;
		let html = renderToStaticMarkup(<Icon />);
		expect(html, name).toMatch(/^<svg[^>]* data-(nucleo|filled)-icon=""/);
	}
});

test("GitHub reference glyphs share the 16px octicon grid and stay decorative", () => {
	let glyphs = [
		icons.PullRequestOpenIcon,
		icons.PullRequestMergedIcon,
		icons.PullRequestClosedIcon,
		icons.PullRequestDraftIcon,
		icons.IssueOpenIcon,
		icons.IssueCompletedIcon,
		icons.IssueNotPlannedIcon,
		icons.PendingIcon,
		icons.PrivateIcon,
	];
	let drawn = new Set<string>();
	for (let Glyph of glyphs) {
		let html = renderToStaticMarkup(<Glyph />);
		expect(html, Glyph.name).toContain('viewBox="0 0 16 16"');
		expect(html, Glyph.name).toContain('aria-hidden="true"');
		drawn.add(html);
	}
	expect(drawn.size).toBe(glyphs.length);
});
