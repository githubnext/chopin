#!/usr/bin/env bun
/**
 * The browser's `localStorage` and `sessionStorage`, named only in the helper that guards them.
 *
 * A browser that blocks site data throws from the getter itself, so one unguarded read stops the
 * page from rendering. The app and its packages reach storage through
 * `packages/editor/src/browser-storage.ts`; `apps/web/index.html`'s theme script, which runs
 * before any module, guards its own. Tests, which install a stand-in storage, are not shipped.
 * Prose about storage in a comment is not a use of it. lib0's own read is checked below.
 */

import { parse } from "@babel/parser";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(import.meta.dir);
const ROOTS = ["apps/web", "packages"];
const ALLOWED = new Set(["packages/editor/src/browser-storage.ts", "apps/web/index.html"]);
const NAMES = new Set(["localStorage", "sessionStorage"]);
const SCRIPT = /\.(?:[cm]?js|jsx|ts|tsx)$/;

/** The lines of `source` that name the browser's storage in code or a string. */
export function directStorageUses(source: string, file: string): number[] {
	if (file.endsWith(".html")) {
		return source.split("\n").flatMap((line, index) =>
			/\b(?:localStorage|sessionStorage)\b/.test(line) ? [index + 1] : []
		);
	}
	let tokens = parse(source, {
		sourceType: "unambiguous",
		plugins: file.endsWith(".tsx")
			? ["typescript", "jsx"]
			: file.endsWith(".ts")
			? ["typescript"]
			: ["jsx"],
		tokens: true,
	}).tokens as { value?: unknown; loc: { start: { line: number } } }[];
	let lines = new Set<number>();
	for (let token of tokens) {
		if (typeof token.value === "string" && NAMES.has(token.value)) lines.add(token.loc.start.line);
	}
	return [...lines];
}

function sources(dir: string, found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, found);
		else if ((SCRIPT.test(entry) || entry.endsWith(".html")) && !/\.test\./.test(entry)) {
			found.push(path);
		}
	}
	return found;
}

/**
 * lib0, which Yjs loads, reads `localStorage` unguarded as it loads, so a browser whose storage
 * refuses reads stops the editor; `patches/lib0@<version>.patch` guards that read. Bun drops a patch
 * without a word once the installed version moves, so a bump fails here until the patch is made
 * again for it, or dropped if lib0 guards the read itself.
 */
function lib0Unguarded(): string | undefined {
	let manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	let patched = Object.keys(manifest.patchedDependencies ?? {}).filter(name =>
		name.startsWith("lib0@")
	);
	let environment = Bun.resolveSync(
		"lib0/environment",
		Bun.resolveSync("yjs", join(ROOT, "packages/editor")),
	);
	let { version } = JSON.parse(readFileSync(join(dirname(environment), "package.json"), "utf8"));
	if (patched.length !== 1 || patched[0] !== `lib0@${version}`) {
		return `lib0 ${version} is installed, but its storage patch is for ${
			patched.join(", ") || "no version"
		}. Make patches/lib0@${version}.patch with bun patch, or drop it if lib0 now guards the read.`;
	}
	if (!readFileSync(environment, "utf8").includes("damaged profile")) {
		return `lib0 ${version} is installed without its storage patch. Run bun install.`;
	}
	return undefined;
}

if (import.meta.main) {
	let problems = ROOTS.flatMap(root => sources(join(ROOT, root))).flatMap(path => {
		let file = relative(ROOT, path);
		if (ALLOWED.has(file)) return [];
		return directStorageUses(readFileSync(path, "utf8"), file).map(line => `${file}:${line}`);
	});
	if (problems.length) {
		console.error(
			`localStorage and sessionStorage throw where a browser blocks site data. Use safeLocalStorage `
				+ `or safeSessionStorage from @chopin/editor/browser-storage instead:\n  ${
					problems.join("\n  ")
				}`,
		);
	}
	let lib0 = lib0Unguarded();
	if (lib0) console.error(lib0);
	if (problems.length || lib0) process.exit(1);
}
