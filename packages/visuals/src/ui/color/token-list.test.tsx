import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TokenList } from "./token-list";

import type { SwatchRef, TokenRow } from "@chopin/color";

let gray450: SwatchRef = { hue: "gray", step: "450" };
let gray400: SwatchRef = { hue: "gray", step: "400" };
let rows: TokenRow[] = [
	{
		name: "neutral-graphic",
		group: "neutral",
		ref: gray450,
		original: gray450,
		value: { l: 0.6681, c: 0.0105, h: 95 },
		retargeted: false,
	},
	{
		name: "neutral-icon",
		group: "neutral",
		ref: gray400,
		original: gray450,
		value: { l: 0.74, c: 0.008, h: 95 },
		retargeted: true,
	},
	{
		name: "ghost",
		group: "danger",
		ref: { hue: "gone", step: "1" },
		original: { hue: "gone", step: "1" },
		value: null,
		retargeted: false,
	},
];

describe("TokenList", () => {
	test("groups rows with leader lines, native selects, and swatch buttons", () => {
		let markup = renderToStaticMarkup(
			<TokenList
				onOpen={() => {}}
				onRetarget={() => {}}
				rows={rows}
				swatches={[gray450, gray400]}
			/>,
		);
		expect(markup).toContain(">neutral</h3>");
		expect(markup).toContain(">danger</h3>");
		expect(markup).toContain('class="cv-token-leader"');
		expect(markup).toContain('aria-label="neutral-graphic color"');
		expect(markup).toMatch(/<option[^>]*selected=""[^>]*>gray 450<\/option>/);
		expect(markup).toContain("was gray 450");
		expect(markup).toContain('data-tone="danger"');
		expect(markup).toContain(">missing</option>");
		expect(markup).toContain('aria-label="Open gray 450"');
		let values = Array.from(markup.matchAll(/<option[^>]*value="([^"]+)"/g), match => match[1]);
		expect(new Set(values).size).toBe(values.length);
	});
});
