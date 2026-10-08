import { expect, test } from "bun:test";
import { DIAGRAM_FIXTURES } from "../src/fixtures";
import { DIAGRAM_ALIASES, DIAGRAM_TYPES, renderDiagram } from "../src/render";

test("every registered renderer has one resolved fixture with valid geometry and motion", () => {
	let types = Object.keys(DIAGRAM_TYPES).sort();
	let fixtures = DIAGRAM_FIXTURES.map((entry) => entry.type).sort();
	expect(fixtures).toEqual(types);
	for (let { type, spec } of DIAGRAM_FIXTURES) {
		let result = renderDiagram(spec);
		expect(result.ok, `${type}: ${JSON.stringify(result.ok ? [] : result.problems)}`).toBe(true);
		if (!result.ok) continue;
		expect(result.type).toBe(type);
		expect(result.body.length).toBeGreaterThan(100);
		expect(result.viewBox.every(Number.isFinite)).toBe(true);
		expect(result.viewBox[2]).toBeGreaterThan(0);
		expect(result.viewBox[3]).toBeGreaterThan(0);
		expect(result.steps).toBeGreaterThan(0);
		expect(result.steps).toBeLessThanOrEqual(12);
		expect(result.body).toContain("data-sc-step");
		expect(result.diagnostics.filter((issue) => issue.code.startsWith("E_"))).toEqual([]);
	}
});

test("all aliases normalize and render with their required data shape", () => {
	expect(Object.keys(DIAGRAM_ALIASES)).toHaveLength(15);
	for (let [alias, base] of Object.entries(DIAGRAM_ALIASES)) {
		let fixture = DIAGRAM_FIXTURES.find((entry) => entry.type === base);
		expect(fixture).toBeDefined();
		let spec = alias === "marimekko"
			? { type: alias, columns: [{ label: "A", segments: [["one", 2], ["two", 3]] }] }
			: alias === "dumbbell"
			? { type: alias, data: [["A", 2, 3], ["B", 4, 5]] }
			: { ...fixture?.spec, type: alias };
		let result = renderDiagram(spec);
		expect(result.ok, `${alias}: ${JSON.stringify(result.ok ? [] : result.problems)}`).toBe(true);
		if (result.ok) expect(result.type).toBe(base);
	}
});

test("text and attribute payloads remain escaped", () => {
	let result = renderDiagram({
		type: "architecture",
		nodes: [
			{ id: "a", label: "<script>x</script>", row: 0, col: 0 },
			{ id: "b", label: "A & B", row: 0, col: 1 },
		],
		edges: [["a", "b", '" onload="alert(1)']],
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.body).not.toContain("<script>");
	expect(result.body).toContain("&lt;script&gt;");
	expect(result.body).toContain("A &amp; B");
	expect(result.body).not.toContain('onload="alert(1)');
});

test("geometry checks do not reject ordinary text that names an invalid number", () => {
	let result = renderDiagram({
		type: "architecture",
		nodes: [{ id: "a", label: "undefined", row: 0, col: 0 }],
	});
	expect(result.ok).toBe(true);
});

test("invalid and privileged input fails with structured problems", () => {
	let cases: Array<[unknown, string]> = [
		[{ type: "constructor" }, "E_TYPE"],
		[{ type: { toString: "not a function" } }, "E_TYPE"],
		[{ type: "bar", data: "./sales.csv" }, "E_PATH"],
		[{ type: "sankey", links: "./flow.csv" }, "E_PATH"],
		[{ type: "bar", data: [["x", 1]], out: "/tmp/diagram.svg" }, "E_PATH"],
		[{ type: "bar", data: [["x", Number.POSITIVE_INFINITY]] }, "E_NUMBER"],
		[{ type: "bar", data: [["x", 1]], style: "sketchy" }, "E_STYLE"],
		[
			{ type: "bar", data: Array.from({ length: 201 }, (_, index) => [String(index), index]) },
			"E_LIMIT",
		],
		[{ type: "bar", data: [["x", 1]], colour: "red" }, "E_SPEC"],
	];
	let cyclic: Record<string, unknown> = { type: "bar" };
	cyclic.data = cyclic;
	cases.push([cyclic, "E_VALUE"]);
	for (let [input, code] of cases) {
		let result = renderDiagram(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems[0]?.code).toBe(code);
	}
});

test("rendering is deterministic across other calls", () => {
	let first = DIAGRAM_FIXTURES.find((entry) => entry.type === "architecture")?.spec;
	let other = DIAGRAM_FIXTURES.find((entry) => entry.type === "bar")?.spec;
	expect(first).toBeDefined();
	expect(other).toBeDefined();
	let a = renderDiagram(first);
	renderDiagram(other);
	let b = renderDiagram(first);
	expect(b).toEqual(a);
});
