import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const THEME = readFileSync(join(import.meta.dir, "../../../../packages/visuals/theme.css"), "utf8");
const COLOUR_FONTS = ["Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"];

function families(token: string): string[] {
	let value = THEME.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1] ?? "";
	return value.split(",").map(family => family.trim().replace(/^"|"$/g, ""));
}

test("every letter is Inter's, and an emoji is the platform's before a generic family's", () => {
	let sans = families("--font-sans");
	expect(sans[0]).toBe("Inter Variable");
	// Each platform's colour emoji font, in Slack's order, ahead of any generic family that could
	// draw an emoji as a black outline (Linux's `sans-serif` is DejaVu Sans, which has them).
	expect(sans.slice(1, 4)).toEqual(COLOUR_FONTS);
	expect(sans.at(-1)).toBe("sans-serif");
});

test("where only emoji are drawn, the emoji fonts come first and the text font after them", () => {
	let emoji = families("--font-emoji");
	expect(emoji).toEqual([...COLOUR_FONTS, "var(--font-sans)"]);
});
