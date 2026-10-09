import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DIAGRAM_TYPOGRAPHY_SOURCE, diagramTypographyFoundation } from "./diagram-typography";
import { inspect } from "./scan";
import { extractSource } from "./source";

let source = readFileSync(join(import.meta.dir, "../..", DIAGRAM_TYPOGRAPHY_SOURCE), "utf8");

test("canvas typography exports exactly the measured role values", () => {
	let foundation = diagramTypographyFoundation(source);
	expect(foundation.errors).toEqual([]);
	expect(Object.keys(foundation.variables)).toHaveLength(24);
	expect(foundation.variables["--diagram-label-font-size"]).toBe("14px");
	expect(foundation.variables["--diagram-sub-font-size"]).toBe("12px");
	expect(foundation.variables["--diagram-tag-font-size"]).toBe("10px");
	expect(foundation.variables["--diagram-edge-font-size"]).toBe("12px");
});

test("a render-only override cannot drift from measurement or introduce another style", () => {
	let changed = source.replace("`${DIAGRAM_TYPE.label.size}px`", '"99px"');
	expect(changed).not.toBe(source);
	expect(diagramTypographyFoundation(changed).errors).toContain(
		"Diagram typography token drift: --diagram-label-font-size",
	);
	let unrelated = source.replace(
		'"--diagram-label-font-size":',
		'color: "red", "--diagram-label-font-size":',
	);
	expect(diagramTypographyFoundation(unrelated).errors).toContain(
		"Diagram typography foundation exports an unrelated styling property",
	);
});

test("catalog roles must retain valid metrics and shared font families", () => {
	for (let [before, after] of [["size: 14", "size: 999"], ['"var(--font-sans)"', '"Comic Sans"']]) {
		expect(diagramTypographyFoundation(source.replace(before!, after!)).errors.length)
			.toBeGreaterThan(0);
	}
});

test("a registered foundation import cannot hide caller styles or mutation", () => {
	let foundation = diagramTypographyFoundation(source);
	let policy = {
		canonical: new Map(Object.entries(foundation.variables)),
		aliases: new Map(),
		typographyProperties: foundation.properties,
	};
	let consumer =
		'import { diagramTypographyVariables } from "./core/tokens.mjs"; <figure style={diagramTypographyVariables} />;';
	let check = (source: string) =>
		inspect(
			"sample.tsx",
			extractSource("sample.tsx", source, (_, name) =>
				name === "diagramTypographyVariables" ? foundation.variables : undefined),
			policy,
		);
	expect(check(consumer)).toEqual([]);
	expect(
		check(`${consumer}<div style={{fontSize: 99}} />;`).some(finding =>
			finding.family === "typography"
		),
	).toBe(true);
	expect(
		check(
			consumer.replace(
				"<figure",
				'Object.assign(diagramTypographyVariables, {color:"red"}); <figure',
			),
		).some(finding => finding.family === "dynamic"),
	).toBe(true);
});

test("diagram roles are property-specific and cannot launder local overrides", () => {
	let foundation = diagramTypographyFoundation(source);
	let policy = {
		canonical: new Map(Object.entries(foundation.variables)),
		aliases: new Map(),
		typographyProperties: foundation.properties,
	};
	for (
		let source of [
			".bad { color: var(--diagram-label-font-size); }",
			".bad { --diagram-label-font-size: 99px; }",
		]
	) expect(inspect("sample.css", extractSource("sample.css", source), policy)).toHaveLength(1);
});
