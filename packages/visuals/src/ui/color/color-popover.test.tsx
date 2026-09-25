import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ColorPopover, withHue } from "./color-popover";

let gray = { l: 0.6681, c: 0.0105, h: 95 };
let contrast = {
	against: "page",
	onAgainstChange() {},
	onPurposeChange() {},
	options: [{ id: "page", label: "Page", value: { l: 1, c: 0, h: 0 } }],
	purpose: "graphic" as const,
};

describe("withHue", () => {
	test("keeps chroma when a hue sweep leaves the gamut", () => {
		let vivid = { l: 0.7, c: 0.19, h: 30 };
		expect(withHue(vivid, 140)).toEqual({ l: 0.7, c: 0.19, h: 140 });
		expect(withHue(withHue(vivid, 140), 30)).toEqual(vivid);
	});
});

describe("ColorPopover", () => {
	test("composes the plane, hue strip, compare bar, field and contrast", () => {
		let markup = renderToStaticMarkup(
			<ColorPopover
				contrast={contrast}
				onChange={() => {}}
				previous={{ l: 0.74029, c: 0.00856, h: 95 }}
				title="Gray 450"
				value={gray}
			/>,
		);
		expect(markup).toContain(">Gray 450<");
		expect(markup).toContain('aria-label="Lightness and chroma"');
		expect(markup).toContain('aria-valuetext="Lightness 66.8%, chroma 0.0105"');
		expect(markup).toContain('aria-label="Hue"');
		expect(markup).toContain('aria-orientation="vertical"');
		expect(markup).toContain('aria-label="Restore previous color"');
		expect(markup).toContain("3.00:1");
		expect(markup).toContain("was 2.30:1");
	});

	test("disables restore when nothing changed", () => {
		let markup = renderToStaticMarkup(
			<ColorPopover
				contrast={contrast}
				onChange={() => {}}
				previous={gray}
				title="Gray 450"
				value={gray}
			/>,
		);
		expect(markup).toMatch(
			/<button[^>]*disabled=""[^>]*aria-label="Restore previous color"|aria-label="Restore previous color"[^>]*disabled=""/,
		);
	});
});
