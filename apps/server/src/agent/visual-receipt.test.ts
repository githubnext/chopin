import { expect, test } from "bun:test";

import { visualExample } from "./visual-catalog";
import { bindVisualRoute, checkVisualRoute } from "./visual-receipt";

let passage = "Calling an async function returns a future. Polling advances its body.";
let target = { op: "insert" as const, index: 3 };
let route = {
	index: 0,
	kind: "diagram" as const,
	type: "flowchart",
	possibility: 0.9,
	helpfulness: 0.8,
	confidence: 0.7,
};
let flowchart = `\`\`\`seecode\n${JSON.stringify(visualExample("flowchart"))}\n\`\`\``;

test("a visual route is required for an assessed explanatory edit", () => {
	expect(checkVisualRoute({
		required: true,
		receipt: undefined,
		revision: 4,
		passage,
		target,
		authored: passage,
	})).toEqual({ ok: false, reason: "missing-route" });
});

test("a receipt binds the source passage, revision, and insertion target", () => {
	let receipt = bindVisualRoute({ revision: 4, passage, target, route });
	let valid = {
		required: true,
		receipt,
		revision: 4,
		passage,
		target,
		authored: `${passage}\n\n${flowchart}`,
	};
	expect(checkVisualRoute(valid)).toEqual({ ok: true });
	expect(checkVisualRoute({ ...valid, revision: 5 })).toEqual({ ok: false, reason: "stale-route" });
	expect(checkVisualRoute({ ...valid, passage: `${passage} Later detail.` })).toEqual({
		ok: false,
		reason: "changed-passage",
	});
	expect(checkVisualRoute({ ...valid, authored: `Different claim.\n\n${flowchart}` })).toEqual({
		ok: false,
		reason: "changed-passage",
	});
	expect(checkVisualRoute({
		...valid,
		authored: `\`\`\`text\n${passage}\n\`\`\`\n\n${flowchart}`,
	})).toEqual({ ok: false, reason: "changed-passage" });
	expect(checkVisualRoute({ ...valid, target: { op: "insert", index: 4 } })).toEqual({
		ok: false,
		reason: "wrong-placement",
	});
	expect(checkVisualRoute({ ...valid, authored: `${passage}\n\n${flowchart}\n\nAnother claim.` }))
		.toEqual({ ok: false, reason: "unassessed-content" });
	let extraDiagram = `\`\`\`seecode\n${JSON.stringify(visualExample("dependency"))}\n\`\`\``;
	expect(checkVisualRoute({
		...valid,
		authored: `${passage}\n\n${flowchart}\n\n${extraDiagram}`,
	})).toEqual({ ok: false, reason: "unassessed-content" });
});

test("a selected diagram cannot silently become prose or a different type", () => {
	let receipt = bindVisualRoute({ revision: 4, passage, target, route });
	let base = { required: true, receipt, revision: 4, passage, target };
	expect(checkVisualRoute({ ...base, authored: passage })).toEqual({
		ok: false,
		reason: "missing-selected-visual",
	});
	let other = `\`\`\`seecode\n${JSON.stringify(visualExample("dependency"))}\n\`\`\``;
	expect(checkVisualRoute({ ...base, authored: `${passage}\n\n${other}` })).toEqual({
		ok: false,
		reason: "wrong-type",
	});
});

test("a selected table requires an actual table in the authored source", () => {
	let receipt = bindVisualRoute({
		revision: 4,
		passage,
		target,
		route: { ...route, kind: "table" },
	});
	let base = { required: true, receipt, revision: 4, passage, target };
	expect(checkVisualRoute({ ...base, authored: passage })).toEqual({
		ok: false,
		reason: "missing-selected-visual",
	});
	expect(checkVisualRoute({
		...base,
		authored: `${passage}\n\n| Command | Purpose |\n| --- | --- |\n| run | scripts |`,
	})).toEqual({ ok: true });
});

test("a prose route cannot be overridden with a diagram", () => {
	let receipt = bindVisualRoute({
		revision: 4,
		passage,
		target,
		route: { index: 0, kind: "prose", reason: "no-explanatory-gain" },
	});
	expect(checkVisualRoute({
		required: true,
		receipt,
		revision: 4,
		passage,
		target,
		authored: `${passage}\n\n${flowchart}`,
	})).toEqual({ ok: false, reason: "wrong-type" });
});

test("a selected type with an invalid spec is refused", () => {
	let receipt = bindVisualRoute({ revision: 4, passage, target, route });
	expect(checkVisualRoute({
		required: true,
		receipt,
		revision: 4,
		passage,
		target,
		authored: `${passage}\n\n\`\`\`seecode\n{"type":"flowchart"}\n\`\`\``,
	})).toEqual({
		ok: false,
		reason: "invalid-visual",
		problems: [{ code: "E_SPEC", at: "nodes", msg: "is required" }],
	});
	expect(checkVisualRoute({
		required: true,
		receipt,
		revision: 4,
		passage,
		target,
		authored: `${passage}\n\n\`\`\`seecode\n{bad json}\n\`\`\``,
	})).toEqual({
		ok: false,
		reason: "invalid-visual",
		problems: [{ code: "E_JSON", at: "diagram", msg: "Diagram source must be valid JSON." }],
	});
});
