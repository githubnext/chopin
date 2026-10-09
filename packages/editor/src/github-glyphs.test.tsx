import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { GitHubGlyph, GLYPH_NAMES, glyphName } from "./github-glyphs";

import type { GlyphName } from "./github-glyphs";

/** The mask URL the pill stylesheet should carry for one glyph. */
function glyphMask(name: GlyphName): string {
	let svg = renderToStaticMarkup(<GitHubGlyph name={name} />)
		// A standalone image needs the namespace on its root element.
		.replace(/^(<\w+) /, '$1 xmlns="http://www.w3.org/2000/svg" ');
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

let css = readFileSync(join(import.meta.dir, "github-references.css"), "utf8");

test("the pill stylesheet masks with exactly the @chopin/icons glyphs", () => {
	for (let name of GLYPH_NAMES) {
		let rule = new RegExp(`--gh-glyph-${name}: (url\\("[^"]+"\\));`).exec(css);
		expect(rule?.[1], name).toBe(glyphMask(name));
	}
});

test("an unknown status keeps its kind's glyph", () => {
	expect(glyphName("unknown", "pull")).toBe("pr-open");
	expect(glyphName("unknown", "issue")).toBe("issue-open");
	expect(glyphName("pr-merged", "pull")).toBe("pr-merged");
});
