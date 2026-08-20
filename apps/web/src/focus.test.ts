/**
 * That nothing has quietly opted out of the one focus rule in `theme.css`, by
 * suppressing the outline or by drawing a second answer beside it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

/** Every matching source under the repo, excluding dependencies. */
function sources(dir: string, suffixes: string[], found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, suffixes, found);
		else if (suffixes.some(suffix => entry.endsWith(suffix))) found.push(path);
	}
	return found;
}

const ROOTS = [join(ROOT, "apps"), join(ROOT, "packages")];
const COMPONENTS = ROOTS.flatMap(root => sources(root, [".tsx"]));
const THEME = join(ROOT, "apps/web/src/theme.css");
const STYLES = ROOTS.flatMap(root => sources(root, [".css"])).filter(file => file !== THEME);

const FOCUS_OUTLINE =
	/:focus(?:-visible|-within)?\b[^{]*\{[^}]*(?:\boutline(?:-(?:color|offset|style|width))?\s*:)/s;
const FOCUS_UTILITY =
	/\b(?:(?:group|peer)-)?focus(?:-visible|-within)?:!?(?:outline|ring)(?=[-:\s"'`}\]])/;
const OUTLINE_SUPPRESSION =
	/\boutline(?:-style|-width)?\s*:\s*(?:none\b|0(?:[a-z%]+)?(?:\s|[;}!]))/;
const OUTLINE_SUPPRESSION_UTILITY = /\b(?:outline-none|outline-0|outline-hidden)\b/;
const FOCUS_TOKEN_OVERRIDE = /--focus-ring-(?:color|width|offset)\s*:/;

/** Files whose markup matches, reported by path so a failure names the offender. */
function offenders(files: string[], pattern: RegExp): string[] {
	return files
		.filter(file => pattern.test(readFileSync(file, "utf8")))
		.map(file => file.slice(ROOT.length + 1));
}

describe("focus", () => {
	it("leaves no component suppressing the outline it is meant to show", () => {
		expect(offenders(COMPONENTS, OUTLINE_SUPPRESSION_UTILITY)).toEqual([]);
		expect(offenders(STYLES, OUTLINE_SUPPRESSION)).toEqual([]);
	});

	it("keeps one focus dialect rather than three", () => {
		expect(offenders(COMPONENTS, FOCUS_UTILITY)).toEqual([]);
	});

	it("keeps focus geometry in the theme", () => {
		expect(offenders(STYLES, FOCUS_OUTLINE)).toEqual([]);
		expect(offenders([...STYLES, ...COMPONENTS], FOCUS_TOKEN_OVERRIDE)).toEqual([]);
	});
});
