import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ColorField, commitText } from "./color-field";

let gray = { l: 0.6681, c: 0.0105, h: 95 };

describe("commitText", () => {
	test("does not emit when the text is unchanged, even in lossy hex", () => {
		expect(commitText("#96958e", "#96958e", gray)).toEqual({ value: null, invalid: false });
	});

	test("keeps source precision when only the displayed hex casing changes", () => {
		expect(commitText("#96958E", "#96958e", gray)).toEqual({ value: null, invalid: false });
	});

	test("emits a parsed change", () => {
		expect(commitText("oklch(0.7 0.0105 95)", "oklch(0.6681 0.0105 95)", gray)).toEqual({
			value: { l: 0.7, c: 0.0105, h: 95 },
			invalid: false,
		});
	});

	test("does not emit an equivalent value written differently", () => {
		expect(commitText("oklch(66.81% 0.0105 95deg)", "oklch(0.6681 0.0105 95)", gray).value)
			.toBeNull();
	});

	test("compares an active draft against its captured baseline", () => {
		expect(commitText("oklch(66.81% 0.0105 95deg)", "oklch(0.6681 0.0105 95)", gray))
			.toEqual({ value: null, invalid: false });
		expect(commitText("oklch(0.71 0.0105 95)", "oklch(0.6681 0.0105 95)", gray))
			.toEqual({ value: { l: 0.71, c: 0.0105, h: 95 }, invalid: false });
	});

	test("marks garbage invalid without emitting", () => {
		expect(commitText("nope", "oklch(0.6681 0.0105 95)", gray)).toEqual({
			value: null,
			invalid: true,
		});
	});
});

describe("ColorField", () => {
	test("renders the formatted value and a unique format select", () => {
		let markup = renderToStaticMarkup(
			<ColorField format="oklch" onChange={() => {}} onFormatChange={() => {}} value={gray} />,
		);
		expect(markup).toContain('value="oklch(0.6681 0.0105 95)"');
		expect(markup).toContain(">OKLCH<");
		expect(markup).toContain(">HEX<");
		expect(markup).not.toContain("Outside sRGB");
	});

	test("flags out-of-gamut values", () => {
		let markup = renderToStaticMarkup(
			<ColorField
				format="hex"
				onChange={() => {}}
				onFormatChange={() => {}}
				value={{ l: 0.7, c: 0.3, h: 140 }}
			/>,
		);
		expect(markup).toContain("Outside sRGB, shown clipped");
	});

	test("uses distinct option values across field instances", () => {
		let markup = renderToStaticMarkup(
			<>
				<ColorField format="hex" onChange={() => {}} onFormatChange={() => {}} value={gray} />
				<ColorField format="oklch" onChange={() => {}} onFormatChange={() => {}} value={gray} />
			</>,
		);
		let values = Array.from(markup.matchAll(/<option[^>]*value="([^"]+)"/g), match => match[1]);
		expect(values).toHaveLength(4);
		expect(new Set(values).size).toBe(values.length);
	});
});
