import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { classProblems } from "./classes";
import { declarationProblem, type TokenPolicy } from "./policy";
import { applyExceptions, inspect, scan } from "./scan";
import { extractSource } from "./source";

let policy: TokenPolicy = {
	canonical: new Map(Object.entries({
		"--font-sans": "Inter, sans-serif",
		"--text-sm": "clamp(.8rem, 1vw, .9rem)",
		"--text-sm--line-height": "1.5",
		"--color-brand": "oklch(.5 .1 210)",
		"--radius-md": ".375rem",
		"--duration-fast": "120ms",
		"--ease-out": "cubic-bezier(.2, 0, 0, 1)",
	})),
	aliases: new Map([["--prose-size", ["var(--text-sm)"]]]),
};
let problem = (property: string, value: string) =>
	declarationProblem({ property, value, line: 1, context: "CSS" }, policy);

function fixture(files: Record<string, string>, check: (root: string) => void) {
	let root = mkdtempSync(join(tmpdir(), "chopin-contract-adversarial-"));
	try {
		mkdirSync(join(root, "apps/web"), { recursive: true });
		mkdirSync(join(root, "packages/visuals"), { recursive: true });
		for (let [path, value] of Object.entries(files)) writeFileSync(join(root, path), value);
		check(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("adversarial contract coverage", () => {
	test("rejects an unapproved font fallback and literal colour hidden in a mix", () => {
		expect(problem("font-family", "var(--font-sans), Arial")).toBeDefined();
		expect(problem("font-family", "var(--font-sans, Arial)")).toBeDefined();
		expect(problem("background", "color-mix(in srgb, var(--color-brand) 70%, #f00)")).toBeDefined();
	});

	test("escaped CSS spelling still exposes a literal", () => {
		let source = String.raw`.item { c\6flor: r\65 d; transition: opacity 1\73  ease; }`;
		expect(inspect("sample.css", extractSource("sample.css", source), policy)).toHaveLength(2);
	});

	test("token-based arbitrary colours retain legitimate Tailwind opacity modifiers", () => {
		for (
			let value of [
				"bg-[var(--color-brand)]/50",
				"text-[color:var(--color-brand)]/[.45]",
				"hover:bg-(--color-brand)/25",
			]
		) {
			expect(classProblems(value, policy), value).toEqual([]);
		}
	});

	test("colour-bearing utility prefixes cannot hide raw arbitrary colours", () => {
		for (
			let value of ["from-[#f00]", "via-[red]", "to-[#fff]", "ring-offset-[#f00]", "divide-[#f00]"]
		) {
			expect(classProblems(value, policy), value).toHaveLength(1);
		}
	});

	test("shadow utility variants cannot hide raw arbitrary shadows", () => {
		for (let value of ["inset-shadow-[0_1px_2px_red]", "drop-shadow-[0_1px_2px_red]"]) {
			expect(classProblems(value, policy), value).toHaveLength(1);
		}
	});

	test("a shorthand may use a proven local alias to the named size role", () => {
		expect(problem("font", "400 var(--prose-size)/1.5 var(--font-sans)")).toBeUndefined();
	});

	test("local declarations cannot redefine an approved token as a raw literal", () => {
		fixture({
			"packages/visuals/theme.css": "@theme { --color-brand: oklch(.5 .1 210); }",
			"apps/web/styles.css": ".item { --color-brand: red; color: var(--color-brand); }",
		}, root => expect(scan(root).findings.length).toBeGreaterThan(0));
	});

	test("a checked custom utility can have a name that resembles a built-in utility", () => {
		fixture({
			"packages/visuals/theme.css": "@theme { --text-sm: clamp(.8rem, 1vw, .9rem); }",
			"apps/web/styles.css": "@utility text-document { font-size: var(--text-sm); }",
			"apps/web/view.tsx": '<div className="text-document" />',
		}, root => expect(scan(root).findings).toEqual([]));
	});

	test("canonical file only exempts token definitions, never component rules", () => {
		fixture({
			"packages/visuals/theme.css":
				"@theme static { --color-brand: red; } .bypass { font-size:72px; color:red; border-radius:19px; box-shadow:0 0 9px red; transition:all 123ms ease; }",
		}, root => expect(scan(root).findings).toHaveLength(5));
	});

	test("dynamic exceptions do not cover unrelated identical expressions", () => {
		let source =
			"function A({color}) { return <i style={{color}} />; } function B({color}) { return <b style={{color}} />; }";
		let findings = inspect("sample.tsx", extractSource("sample.tsx", source), policy);
		expect(findings).toHaveLength(2);
		expect(
			applyExceptions(findings, [{
				...findings[0]!,
				count: 1,
				reason: "Reviewed first component.",
			}]),
		).toHaveLength(1);
	});
});
