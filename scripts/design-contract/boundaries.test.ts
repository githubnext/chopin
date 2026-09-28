import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readExceptions } from "./exceptions";
import { applyExceptions, inspect, scan } from "./scan";
import { extractSource } from "./source";

let root = resolve(import.meta.dir, "../..");
let policy = scan(root).policy;
let exceptions = readExceptions(join(root, "scripts/design-contract/exceptions.json"));

function check(file: string, change: (source: string) => string) {
	let source = readFileSync(join(root, file), "utf8");
	let allowed = exceptions.filter(entry => entry.file === file);
	let findings = (text: string) => inspect(file, extractSource(file, text), policy);
	expect(applyExceptions(findings(source), allowed)).toEqual([]);
	let changed = change(source);
	expect(changed).not.toBe(source);
	return applyExceptions(findings(changed), allowed);
}

describe("reviewed dynamic boundaries stay narrow", () => {
	test("a specimen font-size waiver never covers a literal replacement", () => {
		let errors = check(
			"apps/web/src/design-audit/foundations.tsx",
			source => source.replace("fontSize: `var(${size})`", 'fontSize: "9px"'),
		);
		expect(errors.some(error => error.includes("font-size: 9px"))).toBe(true);
		expect(errors.some(error => error.startsWith("Stale design exception"))).toBe(true);
	});

	test("a participant-color waiver never covers a hardcoded interface color", () => {
		let errors = check(
			"packages/editor/src/face.tsx",
			source => source.replace("background: color(handle)", 'background: "#123456"'),
		);
		expect(errors.some(error => error.includes("background: #123456"))).toBe(true);
	});

	test("a wrapper prop-spread waiver never covers an additional inline style", () => {
		let errors = check(
			"packages/icons/src/icon.tsx",
			source => source.replace("{...props}", '{...props} style={{ color: "red" }}'),
		);
		expect(errors.some(error => error.includes("color: red"))).toBe(true);
	});

	test("changing a reviewed wrapper body cannot hide behind the same spread expression", () => {
		let errors = check(
			"packages/icons/src/icon.tsx",
			source => source.replace("{...props}", '{...Object.assign(props, {style:{color:"red"}})}'),
		);
		expect(
			errors.some(error =>
				error.includes("reviewed dynamic owner changed") || error.includes("dynamic style requires")
			),
		).toBe(true);
	});

	test("new dynamic sinks fail even in an already reviewed file", () => {
		let errors = check(
			"packages/icons/src/icon.tsx",
			source => `${source}\nfunction Unreviewed({color}) { return <span style={{color}} />; }`,
		);
		expect(errors.some(error => error.includes("dynamic style requires"))).toBe(true);
	});
});
