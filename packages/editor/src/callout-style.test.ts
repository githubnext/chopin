import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let styles = readFileSync(join(import.meta.dir, "callout.css"), "utf8");

test("callout types map their dedicated icon colour", () => {
	for (
		let [type, token] of [
			["note", "--color-neutral-icon"],
			["tip", "--color-success-icon"],
			["important", "--color-brand"],
			["warning", "--color-warning-icon"],
			["danger", "--color-danger-icon"],
		] as const
	) {
		expect(styles).toMatch(
			new RegExp(
				`\\[data-plan-type="${type}"\\],[^{]+\\{[^}]*--callout-icon:\\s*var\\(${token}\\)`,
				"s",
			),
		);
	}
});

test("only callout icons use the dedicated icon colour", () => {
	expect(styles).toMatch(
		/\.plan-callout-type\s*{[^}]*color:\s*var\(--callout-icon\)/s,
	);
	expect(styles).toMatch(
		/\.plan-callout-type > \[data-nucleo-icon\]\s*{[^}]*color:\s*var\(--callout-icon\)/s,
	);
	expect(styles).toMatch(
		/\.plan-callout-option > svg:first-child\s*{[^}]*color:\s*var\(--callout-icon\)/s,
	);
	expect(styles).toMatch(
		/\.plan-callout-title\s*{[^}]*color:\s*var\(--callout-ink\)/s,
	);
	expect(styles.match(/var\(--callout-icon\)/g)).toHaveLength(3);
});

test("callouts share the compact aligned spacing", () => {
	expect(styles).toMatch(/\[data-plan-type\]\s*{[^}]*padding:\s*0\.75rem 0\.875rem/s);
	expect(styles).toMatch(/\.plan-callout-heading\s*{[^}]*gap:\s*0\.375rem/s);
	expect(styles).toMatch(
		/\.plan-callout-type > svg,[^{]+{[^}]*width:\s*0\.875rem;[^}]*height:\s*0\.875rem/s,
	);
	expect(styles).toMatch(/\[data-plan-body\]\s*{[^}]*padding-inline-start:\s*2\.125rem/s);
	expect(styles).toMatch(/\[data-plan-body\] > :first-child\s*{[^}]*margin-block-start:\s*0/s);
});
