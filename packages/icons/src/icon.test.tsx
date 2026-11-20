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

test("provider marks are monochrome, sized as asked and decorative unless named", () => {
	for (let Mark of [icons.OpenAIIcon, icons.AnthropicIcon]) {
		let html = renderToStaticMarkup(<Mark size={18} />);
		expect(html, Mark.name).toContain('viewBox="0 0 24 24"');
		expect(html, Mark.name).toContain('width="18"');
		expect(html, Mark.name).toContain('height="18"');
		expect(html, Mark.name).toContain('fill="currentColor"');
		expect(html, Mark.name).toContain('aria-hidden="true"');
		expect(html, Mark.name).not.toMatch(/fill="#/);

		let named = renderToStaticMarkup(<Mark aria-label="Provider" />);
		expect(named, Mark.name).toContain('aria-label="Provider"');
		expect(named, Mark.name).toContain('role="img"');
		expect(named, Mark.name).not.toContain("aria-hidden");
	}
	expect(renderToStaticMarkup(<icons.OpenAIIcon />)).not.toBe(
		renderToStaticMarkup(<icons.AnthropicIcon />),
	);
});

test("the half-progress icon is a ring with a filled half, in the current colour", () => {
	let html = renderToStaticMarkup(<icons.ProgressHalfIcon />);
	expect(html).toContain('viewBox="0 0 18 18"');
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain('fill="currentColor"');
	expect(html).not.toContain("#212121");
});
