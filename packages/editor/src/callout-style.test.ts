import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let styles = readFileSync(join(import.meta.dir, "callout.css"), "utf8");

test("callouts share the compact aligned spacing", () => {
	expect(styles).toMatch(/\[data-plan-type\]\s*{[^}]*padding:\s*0\.75rem 0\.875rem/s);
	expect(styles).toMatch(/\.plan-callout-heading\s*{[^}]*gap:\s*0\.375rem/s);
	expect(styles).toMatch(
		/\.plan-callout-type > svg,[^{]+{[^}]*width:\s*0\.875rem;[^}]*height:\s*0\.875rem/s,
	);
	expect(styles).toMatch(/\[data-plan-body\]\s*{[^}]*padding-inline-start:\s*2\.125rem/s);
	expect(styles).toMatch(/\[data-plan-body\] > :first-child\s*{[^}]*margin-block-start:\s*0/s);
});
