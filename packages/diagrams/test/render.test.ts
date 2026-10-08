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
	expect(Object.keys(DIAGRAM_ALIASES).length).toBeGreaterThan(0);
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

test("item based structures reject duplicate node IDs before rendering", () => {
	for (
		let [type, field] of [
			["process", "steps"],
			["pyramid", "levels"],
			["layers", "layers"],
			["loop", "steps"],
		] as const
	) {
		let fixture = DIAGRAM_FIXTURES.find((entry) => entry.type === type);
		expect(fixture).toBeDefined();
		let original = fixture?.spec[field] as Array<string | Record<string, unknown>>;
		let items = original.map((value, index) =>
			index < 2
				? { ...(typeof value === "string" ? { label: value } : value), id: "repeated" }
				: value
		);
		let result = renderDiagram({ ...fixture?.spec, type, [field]: items });
		expect(result.ok, type).toBe(false);
		if (result.ok) continue;
		expect(result.problems[0]).toMatchObject({
			code: "E_DUP_ID",
			at: `${field}[1].id`,
		});
		expect("body" in result).toBe(false);
	}
	let generatedCollision = renderDiagram({
		type: "process",
		steps: ["First", { id: "s0", label: "Second" }],
	});
	expect(generatedCollision.ok).toBe(false);
	if (!generatedCollision.ok) {
		expect(generatedCollision.problems[0]).toMatchObject({
			code: "E_DUP_ID",
			at: "steps[1].id",
		});
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

test("missing chart data suggests inline data only", () => {
	let result = renderDiagram({ type: "bar" });
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.problems[0]?.fix).toContain('"data"');
	expect(result.problems[0]?.fix).not.toContain("path");
});

test("inherited object property names cannot bypass closed schemas", () => {
	let input = JSON.parse(
		'{"type":"architecture","nodes":[{"id":"a","label":"A","row":0,"col":0,"toString":"hidden"}]}',
	);
	let result = renderDiagram(input);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.problems[0]).toMatchObject({
		code: "E_SPEC",
		at: "nodes[0].toString",
		msg: "unknown field",
	});
});

test("parallel graph edges have distinct tracing IDs in metadata and SVG", () => {
	let result = renderDiagram({
		type: "architecture",
		nodes: [
			{ id: "a", label: "A", row: 0, col: 0 },
			{ id: "b", label: "B", row: 0, col: 1 },
		],
		edges: [["a", "b"], ["a", "b"], ["a", "b"]],
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	let ids = result.graph?.edges.map((edge) => edge.id);
	expect(ids).toEqual(["a-b", "a-b-2", "a-b-3"]);
	expect([...result.body.matchAll(/data-sc-edge="([^"]+)"/g)].map((match) => match[1])).toEqual(
		ids,
	);

	let withExplicit = renderDiagram({
		type: "architecture",
		nodes: [
			{ id: "a", label: "A", row: 0, col: 0 },
			{ id: "b", label: "B", row: 0, col: 1 },
		],
		edges: [{ id: "a-b-2", from: "a", to: "b" }, ["a", "b"], ["a", "b"], {
			id: "a-b",
			from: "a",
			to: "b",
		}],
	});
	expect(withExplicit.ok).toBe(true);
	if (withExplicit.ok) {
		let explicitIds = withExplicit.graph?.edges.map((edge) => edge.id);
		expect(explicitIds).toEqual(["a-b-2", "a-b-3", "a-b-4", "a-b"]);
		expect([...withExplicit.body.matchAll(/data-sc-edge="([^"]+)"/g)].map((match) => match[1]))
			.toEqual(explicitIds);
	}
});

test("kanban card IDs are nonempty and unique, and duplicate explicit IDs fail", () => {
	let valid = renderDiagram({
		type: "kanban",
		columns: [
			{ label: "Doing", cards: [{ id: "", label: "First" }, { id: "c0_0", label: "Second" }] },
			{ label: "Done", cards: ["Third"] },
		],
	});
	expect(valid.ok).toBe(true);
	if (valid.ok) {
		let ids = valid.graph?.nodes.map((node) => node.id) || [];
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...valid.body.matchAll(/data-sc-node="([^"]+)"/g)].map((match) => match[1]))
			.toEqual(ids);
	}
	let duplicate = renderDiagram({
		type: "kanban",
		columns: [
			{ label: "Doing", cards: [{ id: "same", label: "First" }] },
			{ label: "Done", cards: [{ id: "same", label: "Second" }] },
		],
	});
	expect(duplicate.ok).toBe(false);
	if (!duplicate.ok) {
		expect(duplicate.problems[0]).toMatchObject({
			code: "E_DUP_ID",
			at: "columns[1].cards[0].id",
		});
	}
});

test("tree edge IDs stay unique when node IDs contain hyphens", () => {
	let result = renderDiagram({
		type: "tree",
		root: {
			id: "root",
			label: "Root",
			children: [
				{ id: "a-b", label: "First", children: [{ id: "c", label: "Leaf one" }] },
				{ id: "a", label: "Second", children: [{ id: "b-c", label: "Leaf two" }] },
			],
		},
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	let ids = result.graph?.edges.map((edge) => edge.id) || [];
	expect(ids).toEqual(["e0", "e1", "e2", "e3"]);
	expect([...result.body.matchAll(/data-sc-edge="([^"]+)"/g)].map((match) => match[1]))
		.toEqual(ids);
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
