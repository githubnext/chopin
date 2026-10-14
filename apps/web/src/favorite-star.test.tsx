import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FavoriteStar } from "./favorite-star";

test("the star is its own toggle, named for what pressing it does", () => {
	let other = renderToStaticMarkup(
		createElement(FavoriteStar, { label: "build-box", favorite: false, onToggle: () => {} }),
	);
	expect(other).toContain('aria-pressed="false"');
	expect(other).toContain('aria-label="Favorite build-box"');
	expect(other).toContain('type="button"');
	expect(other).toContain("data-nucleo-icon");
	let mine = renderToStaticMarkup(
		createElement(FavoriteStar, { label: "build-box", favorite: true, onToggle: () => {} }),
	);
	expect(mine).toContain('aria-pressed="true"');
	expect(mine).toContain('aria-label="Remove build-box as favorite"');
	expect(mine).toContain("data-favorite");
	// Drawn from the app's icon set, never a text glyph.
	expect(mine).not.toMatch(/[★☆]/);
});
