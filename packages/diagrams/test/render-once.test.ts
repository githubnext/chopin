import { expect, test } from "bun:test";
import { DIAGRAM_FIXTURES } from "../src/fixtures";
import { renderDiagram } from "../src/render";

/**
 * A document with dozens of diagrams asks for each one several times as it opens: once to see that
 * it can be drawn, once to draw it, and again at the width its column turns out to have. Routing
 * the edges of a graph is the expensive part, so the same drawing must come back, not be made again.
 */
function fixture(type: string): Record<string, unknown> {
	let found = DIAGRAM_FIXTURES.find(entry => entry.type === type);
	if (!found) throw new Error(`no fixture for ${type}`);
	return structuredClone(found.spec) as Record<string, unknown>;
}

test("the same diagram, read again from the document, is the drawing it was before", () => {
	let first = renderDiagram(fixture("architecture"));
	let again = renderDiagram(fixture("architecture"));
	expect(first.ok).toBe(true);
	expect(again).toBe(first);
});

test("a diagram that already fits its column is the drawing it was without a width", () => {
	let natural = renderDiagram(fixture("dependency"));
	if (!natural.ok) throw new Error("the fixture must draw");
	expect(natural.viewBox[2]).toBeLessThan(600);
	for (let availableWidth of [640, 720, 1000]) {
		expect(renderDiagram(fixture("dependency"), { availableWidth }), `${availableWidth}`).toBe(
			natural,
		);
	}
});

test("a diagram wider than its column is drawn compact once, and the wide drawing is kept", () => {
	let wide = renderDiagram(fixture("architecture"));
	let compact = renderDiagram(fixture("architecture"), { availableWidth: 500 });
	if (!wide.ok || !compact.ok) throw new Error("the fixture must draw");
	expect(compact.viewBox[2]).toBeLessThan(wide.viewBox[2]);
	expect(renderDiagram(fixture("architecture"), { availableWidth: 500 })).toBe(compact);
	// The column growing back is not a new drawing either.
	expect(renderDiagram(fixture("architecture"))).toBe(wide);
});

test("a chart redrawn for a column is made once for that column", () => {
	let natural = renderDiagram(fixture("bar"));
	let fitted = renderDiagram(fixture("bar"), { availableWidth: 500 });
	if (!natural.ok || !fitted.ok) throw new Error("the fixture must draw");
	expect(fitted.viewBox[2]).toBeLessThan(natural.viewBox[2]);
	expect(renderDiagram(fixture("bar"), { availableWidth: 500 })).toBe(fitted);
});

test("a diagram that cannot be drawn says why every time it is asked", () => {
	let broken = { ...fixture("architecture"), edges: [["nowhere", "missing", "never"]] };
	let first = renderDiagram(broken);
	expect(first.ok).toBe(false);
	if (first.ok) return;
	let again = renderDiagram({ ...broken });
	expect(again).toEqual(first);
	expect(renderDiagram(fixture("architecture")).ok).toBe(true);
});

test("a changed diagram is drawn afresh, and the drawings are not all kept for good", () => {
	let base = fixture("bar");
	let first = renderDiagram(base);
	let retitled = renderDiagram({ ...base, title: "Another title" });
	if (!first.ok || !retitled.ok) throw new Error("the fixture must draw");
	expect(retitled).not.toBe(first);
	expect(retitled.title).toBe("Another title");
	expect(first.title).not.toBe("Another title");
	// A reader opening documents all day must not keep every drawing it ever made.
	for (let index = 0; index < 700; index++) {
		renderDiagram({ ...base, title: `Distinct ${index}` });
	}
	let after = renderDiagram(base);
	expect(after).not.toBe(first);
	expect(after).toEqual(first);
});
