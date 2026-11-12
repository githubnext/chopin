import { describe, expect, it } from "bun:test";
import { resolveTheme } from "@pierre/diffs";

import { accessibleTheme, CODE_THEME, CODE_THEME_BASE, contrast, legible } from "./code-theme";

describe("the code palette", () => {
	// Measured as the browser draws them: after rounding to 8 bits a channel.
	it("darkens pierre-light's colours in their own hue only as far as 4.5:1", () => {
		expect(legible("#08c0ef", "#ffffff")).toBe("#007fac");
		expect(legible("#d5901c", "#ffffff")).toBe("#aa6700");
		expect(legible("#1ca1c7", "#ffffff")).toBe("#0080a5");
		expect(legible("#18a46c", "#ffffff")).toBe("#008853");
		expect(legible("#d47628", "#ffffff")).toBe("#b95e00");
		// Already AA, or a translucent wash: left as pierre drew it.
		expect(legible("#d32a61", "#ffffff")).toBe("#d32a61");
		expect(legible("#18a46c33", "#ffffff")).toBe("#18a46c33");
	});

	it("puts every word and change mark of the theme at AA on its background", async () => {
		let base = await resolveTheme(CODE_THEME_BASE);
		let theme = accessibleTheme(base);
		expect(theme.name).toBe(CODE_THEME);
		let background = theme.bg!;
		let foregrounds = [
			theme.fg!,
			...Object.entries(theme.colors ?? {})
				.filter(([key, value]) => /foreground$/i.test(key) && /^#[0-9a-f]{6}$/i.test(value))
				.map(([, value]) => value),
			...(theme.settings ?? []).flatMap(rule => rule.settings?.foreground ?? []),
		];
		expect(foregrounds.length).toBeGreaterThan(100);
		let below = foregrounds.filter(colour =>
			/^#[0-9a-f]{6}$/i.test(colour) && contrast(colour, background) < 4.5
		);
		expect(below).toEqual([]);
	});
});
