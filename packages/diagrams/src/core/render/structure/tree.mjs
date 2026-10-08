// Tree / org chart: tidy layout, elbow connectors, reveal by depth.
import { el, roundedPath } from "../../svg.mjs";
import { drawNode, normalizeKind, sizeNode } from "../shared/nodes.mjs";
import { compressSteps } from "../../motion.mjs";

export const family = "structure";

const SIB_GAP = 20;
const LEVEL_GAP = 56;

export function render(spec) {
	const problems = [];
	const dir = spec.dir || (spec.variant === "block" ? "LR" : "TB");
	const all = [];
	const ids = new Set();
	let auto = 0;
	function build(n, depth, parent) {
		const id = n.id || `n${auto++}`;
		if (ids.has(id)) {
			problems.push({
				code: "E_DUP_ID",
				at: id,
				msg: `duplicate id "${id}"`,
				fix: "ids must be unique",
			});
		}
		ids.add(id);
		const node = { ...n, id, depth, parent, kind: normalizeKind(n), children: [] };
		all.push(node);
		node.children = (n.children || []).map((c) => build(c, depth + 1, node));
		return node;
	}
	const root = build(spec.root, 0, null);
	// block decomposition: number every block (1, 1.1, 1.2.1 …) so it can be traced in text
	if (spec.variant === "block") {
		const num = (n, prefix) =>
			n.children.forEach((c, i) => {
				c.tag = c.tag || `${prefix}${i + 1}`;
				num(c, `${prefix}${i + 1}.`);
			});
		root.tag = root.tag || "0";
		num(root, "");
	}
	if (problems.length) return { problems };
	if (all.length > 24) {
		problems.push({
			code: "W_BUDGET",
			at: "root",
			msg: `${all.length} nodes`,
			fix: 'collapse deep branches into a "+N more" leaf or split the tree',
		});
	}
	const maxKids = Math.max(...all.map((n) => n.children.length));
	if (maxKids > 6) {
		problems.push({
			code: "W_FANOUT",
			at: "root",
			msg: `a node has ${maxKids} children`,
			fix: "group siblings under an intermediate node (≤ 6 per parent)",
		});
	}

	all.forEach((n) => sizeNode(n, { minW: 104, maxW: 180 }));
	const horiz = dir === "LR";
	const along = (n) => (horiz ? n.h : n.w); // extent along the sibling axis
	const levels = [];
	for (const n of all) levels[n.depth] = Math.max(levels[n.depth] || 0, horiz ? n.w : n.h);

	function measure(n) {
		if (!n.children.length) return (n.span = along(n));
		const kids = n.children.reduce((s, c) => s + measure(c), 0) + SIB_GAP * (n.children.length - 1);
		return (n.span = Math.max(along(n), kids));
	}
	measure(root);
	const levelPos = [];
	let acc = 0;
	levels.forEach((size, d) => {
		levelPos[d] = acc;
		acc += size + (horiz ? LEVEL_GAP + 24 : LEVEL_GAP);
	});
	function place(n, start) {
		const center = start + n.span / 2;
		if (horiz) {
			n.x = levelPos[n.depth];
			n.y = Math.round(center - n.h / 2);
		} else {
			n.x = Math.round(center - n.w / 2);
			n.y = levelPos[n.depth];
		}
		const kids = n.children.reduce((s, c) => s + c.span, 0) + SIB_GAP * (n.children.length - 1);
		let cur = center - kids / 2;
		for (const c of n.children) {
			place(c, cur);
			cur += c.span + SIB_GAP;
		}
	}
	place(root, 0);

	const steps = compressSteps(
		all.flatMap((n) => [n.depth * 2]).concat(
			all.filter((n) => n.parent).map((n) => n.depth * 2 - 1),
		),
	);
	all.forEach((n, i) => (n.step = steps[i]));
	const edgeNodes = all.filter((n) => n.parent);
	edgeNodes.forEach((n, i) => (n.edgeStep = steps[all.length + i]));

	const edges = edgeNodes.map((n) => {
		const p = n.parent;
		let pts;
		if (horiz) {
			const x0 = p.x + p.w, y0 = p.y + p.h / 2, x1 = n.x, y1 = n.y + n.h / 2;
			const mx = x0 + Math.round((levelPos[n.depth] - x0) / 2);
			pts = y0 === y1
				? [{ x: x0, y: y0 }, { x: x1, y: y1 }]
				: [{ x: x0, y: y0 }, { x: mx, y: y0 }, { x: mx, y: y1 }, { x: x1, y: y1 }];
		} else {
			const x0 = p.x + p.w / 2, y0 = p.y + p.h, x1 = n.x + n.w / 2, y1 = n.y;
			const my = y0 + Math.round((levelPos[n.depth] - y0) / 2);
			pts = x0 === x1
				? [{ x: x0, y: y0 }, { x: x1, y: y1 }]
				: [{ x: x0, y: y0 }, { x: x0, y: my }, { x: x1, y: my }, { x: x1, y: y1 }];
		}
		return el("g", {
			class: `sc-edge ek-${n.kind === "focal" ? "primary" : "muted"}`,
			"data-sc-edge": `${p.id}-${n.id}`,
			"data-from": p.id,
			"data-to": n.id,
			"data-sc-step": n.edgeStep,
			style: `--step:${n.edgeStep}`,
		}, el("path", { class: "e-line sc-draw", d: roundedPath(pts, 6), pathLength: 1 }));
	});

	const minX = Math.min(...all.map((n) => n.x)) - 32;
	const minY = Math.min(...all.map((n) => n.y)) - 32;
	const maxX = Math.max(...all.map((n) => n.x + n.w)) + 32;
	const maxY = Math.max(...all.map((n) => n.y + n.h)) + 32;
	return {
		body: el("g", { class: "sc-edges" }, edges)
			+ el("g", { class: "sc-nodes" }, all.map((n) => drawNode(n, { step: n.step }))),
		viewBox: [minX, minY, maxX - minX, maxY - minY],
		steps: Math.max(...steps),
		problems,
		graph: {
			nodes: all.map((n) => ({ id: n.id, label: n.label })),
			edges: edgeNodes.map((n) => ({ id: `${n.parent.id}-${n.id}`, from: n.parent.id, to: n.id })),
		},
	};
}
