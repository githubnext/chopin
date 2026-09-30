import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TokenPolicy } from "./policy";
import { applyExceptions, inspect, scan } from "./scan";
import { extractSource } from "./source";

let policy: TokenPolicy = { canonical: new Map(), aliases: new Map() };

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
	test("escaped CSS spelling still exposes a literal", () => {
		let source = String.raw`.item { c\6flor: r\65 d; transition: opacity 1\73  ease; }`;
		expect(inspect("sample.css", extractSource("sample.css", source), policy)).toHaveLength(2);
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
