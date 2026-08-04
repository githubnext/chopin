#!/usr/bin/env bun
/**
 * Custom properties that are read but never defined.
 *
 * `var(--nope)` invalidates the whole declaration rather than falling back, so
 * the property resets to its initial value and the result looks deliberate.
 * A reference carrying its own fallback cannot fail this way and is exempt —
 * that is the escape hatch for properties written from script at runtime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(import.meta.dir);
const ROOTS = ["apps", "packages"];

/** Tailwind's internal bookkeeping, so absent from our stylesheets by design. */
const EXTERNAL = ["--tw-"];

/** Sources only: a built `dist` carries third-party CSS we neither wrote nor can fix. */
function stylesheets(dir: string, found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) stylesheets(path, found);
		else if (entry.endsWith(".css")) found.push(path);
	}
	return found;
}

let files = ROOTS.flatMap(root => stylesheets(join(ROOT, root)));

/** A stylesheet with its comments blanked — prose about a token is not a use of one. */
function source(file: string): string {
	return readFileSync(file, "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		comment => comment.replace(/[^\n]/g, " "),
	);
}

let defined = new Set<string>();
for (let file of files) {
	for (let [, name] of source(file).matchAll(/(--[\w-]+)\s*:/g)) {
		defined.add(name!);
	}
}

type Problem = { file: string; line: number; token: string };
let problems: Problem[] = [];

// A non-static `@theme` silently invalidates every result below, so it fails first.
for (let file of files) {
	let text = source(file);
	for (let opened of text.matchAll(/@theme(?!\s+static)(\s+[\w-]+)?\s*\{/g)) {
		let line = text.slice(0, opened.index).split("\n").length;
		console.error(
			`${relative(ROOT, file)}:${line}  @theme is not \`static\`, so Tailwind will prune`
				+ ` theme variables that only hand-written CSS reads, and this check cannot see it.`,
		);
		process.exit(1);
	}
}

for (let file of files) {
	let lines = source(file).split("\n");
	lines.forEach((text, index) => {
		// No comma inside the parentheses: a reference with no fallback of its own.
		for (let [, name] of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
			let token = name!;
			if (defined.has(token)) continue;
			if (EXTERNAL.some(prefix => token.startsWith(prefix))) continue;
			problems.push({ file: relative(ROOT, file), line: index + 1, token });
		}
	});
}

if (problems.length === 0) {
	console.log(`tokens ok — ${defined.size} defined across ${files.length} stylesheets`);
	process.exit(0);
}

console.error(
	`${problems.length} undefined custom ${problems.length === 1 ? "property" : "properties"}:\n`,
);
for (let { file, line, token } of problems) {
	console.error(`  ${file}:${line}  ${token}`);
}
console.error(
	`\nDefine it in the theme, or give the reference a fallback if it is written at runtime.`,
);
process.exit(1);
