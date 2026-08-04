/**
 * That nothing has quietly opted out of the one focus rule in `theme.css`, by
 * suppressing the outline or by drawing a second answer beside it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

/** Every `.tsx` under the repo, excluding dependencies. */
function components(dir: string, found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) components(path, found);
		else if (entry.endsWith(".tsx")) found.push(path);
	}
	return found;
}

const FILES = components(join(ROOT, "apps")).concat(components(join(ROOT, "packages")));

/** Files whose markup matches, reported by path so a failure names the offender. */
function offenders(pattern: RegExp): string[] {
	return FILES
		.filter(file => pattern.test(readFileSync(file, "utf8")))
		.map(file => file.slice(ROOT.length + 1));
}

describe("focus", () => {
	it("leaves no component suppressing the outline it is meant to show", () => {
		expect(offenders(/\boutline-none\b/)).toEqual([]);
	});

	it("keeps one focus dialect rather than three", () => {
		expect(offenders(/focus-visible:ring-[\w-]+/)).toEqual([]);
	});
});
