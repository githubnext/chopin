/**
 * Whether a highlight can be seen.
 *
 * Nothing else can check this. There is no DOM in the test runtime and no
 * `CSS.highlights` to register against, so a mark painted in page-white looks
 * exactly like a mark that failed to paint — which is how an invisible palette
 * shipped twice, once because a percentage was calibrated against a token that
 * was already pale, and once because the visible part of the old rule was an
 * outline rather than the wash it was copied from.
 *
 * So this does the arithmetic instead: resolve each tone against the theme it
 * names, composite it over the page, and insist the result is far enough from
 * the background to be a mark at all. It also checks the colour recorded beside
 * each declaration, because that comment is what the next person will calibrate
 * against and a stale one is worse than none.
 *
 * It lives here rather than beside the stylesheet because the app owns the
 * palette; the editor only names tokens, and a package must not read an app.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Oklch = { l: number; c: number; h: number };

const THEME = readFileSync(join(import.meta.dir, "theme.css"), "utf8");
const STYLES = readFileSync(
	join(import.meta.dir, "../../../packages/editor/src/styles.css"),
	"utf8",
);

/** A colour token, resolving semantic aliases onto the primitive palette. */
function token(name: string): Oklch {
	let declaration = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(THEME)?.[1]?.trim();
	if (!declaration) throw new Error(`no --color-${name} in the theme`);
	let alias = /^var\(--color-([\w-]+)\)$/.exec(declaration);
	if (alias) return token(alias[1]!);
	let found = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(declaration);
	if (!found) throw new Error(`no --color-${name} in the theme`);
	return { l: Number(found[1]), c: Number(found[2]), h: Number(found[3]) };
}

function hex({ c, h, l }: Oklch): string {
	let radians = (h * Math.PI) / 180;
	let a = c * Math.cos(radians);
	let b = c * Math.sin(radians);

	let long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

	let channels = [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];

	return `#${
		channels
			.map(value => {
				let encoded = value <= 0.0031308
					? 12.92 * value
					: 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
				return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
					.toString(16)
					.padStart(2, "0");
			})
			.join("")
	}`;
}

type Mark = { name: string; token: string; recorded: string };

/** Every highlight the stylesheet declares, with the colour written beside it. */
function marks(): Mark[] {
	let pattern = /\/\* (#[0-9a-f]{6}) \*\/\s*\n\s*background-color: var\(--color-([\w-]+)\)/g;
	let named = /::highlight\((plan-[a-z-]+)\)/g;

	let names = [...STYLES.matchAll(named)].map(match => match[1]!);
	let found = [...STYLES.matchAll(pattern)].map((match, index) => ({
		name: names[index] ?? `#${index}`,
		recorded: match[1]!,
		token: match[2]!,
	}));

	if (found.length === 0) throw new Error("no highlight declarations found");
	return found;
}

/**
 * How far a mark has to be from the page to be one.
 *
 * The invisible tone that prompted this rendered `#f9fbff`, a lightness of
 * 0.979 against a page of 1.0. Anything that close is not a highlight, whatever
 * the stylesheet says it is.
 */
const PERCEPTIBLE = 0.04;

describe("marking prose", () => {
	let page = token("page");

	it("declares every highlight against a token the theme has", () => {
		for (let mark of marks()) expect(() => token(mark.token)).not.toThrow();
	});

	it("paints each one far enough from the page to be seen", () => {
		for (let mark of marks()) {
			let painted = token(mark.token);
			let distance = page.l - painted.l;

			// Asserted as an object so a failure names the mark and what it
			// renders as, rather than reporting a bare number nobody can place.
			expect({ mark: mark.name, renders: hex(painted), visible: distance > PERCEPTIBLE })
				.toEqual({ mark: mark.name, renders: hex(painted), visible: true });
		}
	});

	/** The recorded colour is what the next person will calibrate against. */
	it("records beside each one the colour it actually renders", () => {
		for (let mark of marks()) {
			expect({ mark: mark.name, hex: mark.recorded }).toEqual({
				mark: mark.name,
				hex: hex(token(mark.token)),
			});
		}
	});
});
