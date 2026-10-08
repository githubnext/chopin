import { expect, test } from "bun:test";

import { namespaceSvgIds } from "./namespace";

test("namespaces definitions and references without changing model identifiers", () => {
	let body = '<defs><marker id="sc-arrow"/></defs>'
		+ '<g data-sc-node="api"><path marker-end="url(#sc-arrow)"/></g>'
		+ '<use href="#sc-arrow" xlink:href="#sc-arrow"/>';
	let first = namespaceSvgIds(body, "diagram-a");
	let second = namespaceSvgIds(body, "diagram-b");

	expect(first).toContain('id="diagram-a-sc-arrow"');
	expect(first).toContain('marker-end="url(#diagram-a-sc-arrow)"');
	expect(first).toContain('href="#diagram-a-sc-arrow"');
	expect(first).toContain('xlink:href="#diagram-a-sc-arrow"');
	expect(first).toContain('data-sc-node="api"');
	expect(second).toContain('id="diagram-b-sc-arrow"');
	expect(second).not.toContain("diagram-a-sc-arrow");
});

test("leaves unresolved external fragments unchanged", () => {
	let body = '<path fill="url(#missing)"/><use href="#other"/>';
	expect(namespaceSvgIds(body, "diagram-a")).toBe(body);
});
