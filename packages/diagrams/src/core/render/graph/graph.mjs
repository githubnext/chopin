// Graph family renderer: architecture, flowchart, data-flow, dependency,
// deployment, high-level, state, er, db-schema, uml-class, swimlane,
// architecture-delta, it-state, medallion, dp-integration. Claude places nodes on a coarse grid (row/col);
// this file turns that into exact geometry, routes, labels and motion.
import { el, roundedPath, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { drawNode, fieldY, normalizeKind, sizeNode } from "../shared/nodes.mjs";
import { drawEdge, labelBox, placeLabel } from "../shared/edges.mjs";
import { legend } from "../shared/legend.mjs";
import { routeEdges } from "./route.mjs";
import { compressSteps } from "../../motion.mjs";

export const family = "graph";

const BUDGET = {
	strict: [7, 9],
	balanced: [9, 12],
	wide: [16, 20],
	faithful: [24, 36],
	off: [1e9, 1e9],
};
const TYPE_BUDGET = {
	medallion: "wide",
	"dp-integration": "wide",
	er: "wide",
	"db-schema": "wide",
	"it-state": "wide",
	swimlane: "wide",
};
const GROUP_PAD = 16;
const GROUP_TOP = 22;
const DEFAULT_SHAPE = { er: "entity", "db-schema": "entity", "uml-class": "class", state: "state" };
const NO_LEGEND = new Set(["er", "db-schema", "uml-class", "state", "flowchart"]);
const STATUS_NAMES = { ok: "Healthy", risk: "At risk", legacy: "Legacy", retire: "Retire" };

// medallion / dp-integration: {stages:[{label,items:[…]}], edges?} → graph spec.
export function fromStages(spec) {
	const nodes = [];
	const groups = [];
	const edges = spec.edges ? [...spec.edges] : [];
	spec.stages.forEach((st, c) => {
		const gid = `stage${c}`;
		groups.push({ id: gid, label: st.label, style: st.style });
		(st.items || []).forEach((it, r) => {
			const o = typeof it === "string" ? { label: it } : { ...it };
			o.id = o.id || `${gid}_${r}`;
			nodes.push({
				...o,
				row: o.row ?? r,
				col: c,
				group: st.plain ? undefined : gid,
				kind: o.kind || st.kind,
			});
		});
	});
	if (!spec.edges) {
		for (let c = 0; c + 1 < spec.stages.length; c++) {
			const a = nodes.filter((n) => n.col === c), b = nodes.filter((n) => n.col === c + 1);
			a.forEach((n, i) =>
				b.length
				&& edges.push([n.id, b[Math.min(i, b.length - 1)].id, "", c === 0 ? "default" : "primary"])
			);
		}
	}
	const out = {
		...spec,
		nodes,
		edges,
		groups: groups.filter((g) => nodes.some((n) => n.group === g.id)),
	};
	delete out.stages;
	return out;
}

function normEdges(spec, ids, problems) {
	const seen = new Map();
	return (spec.edges || []).map((raw, i) => {
		const e = Array.isArray(raw)
			? { from: raw[0], to: raw[1], label: raw[2] || undefined, kind: raw[3] }
			: { ...raw };
		e.kind = e.kind || "default";
		for (const end of ["from", "to"]) {
			if (!ids.has(e[end]) && String(e[end]).includes(".")) {
				const str = String(e[end]);
				for (let k = str.lastIndexOf("."); k > 0; k = str.lastIndexOf(".", k - 1)) {
					if (ids.has(str.slice(0, k))) {
						e[end === "from" ? "fieldS" : "fieldT"] = str.slice(k + 1);
						e[end] = str.slice(0, k);
						break;
					}
				}
			}
			if (!ids.has(e[end])) {
				const near = [...ids].filter((id) =>
					id.toLowerCase().startsWith(String(e[end]).toLowerCase().slice(0, 2))
				).slice(0, 3);
				problems.push({
					code: "E_EDGE_NODE",
					at: `edges[${i}]`,
					msg: `unknown node "${e[end]}"`,
					fix: near.length ? `use one of: ${near.join(", ")}` : "add the node or fix the id",
				});
			}
		}
		if (e.from === e.to) e.self = true;
		let id = e.id || `${e.from}-${e.to}`;
		if (seen.has(id)) id = `${id}-${seen.get(id) + 1}`;
		seen.set(id, (seen.get(id) || 0) + 1);
		e.id = id;
		return e;
	});
}

// Longest-path ranks on the DAG obtained by dropping DFS back edges.
function ranks(nodes, edges) {
	const out = new Map(nodes.map((n) => [n.id, []]));
	for (const e of edges) out.get(e.from)?.push(e.to);
	const state = new Map();
	const back = new Set();
	const visit = (id) => {
		state.set(id, 1);
		for (const t of out.get(id) || []) {
			if (state.get(t) === 1) back.add(`${id}>${t}`);
			else if (!state.get(t)) visit(t);
		}
		state.set(id, 2);
	};
	nodes.forEach((n) => !state.get(n.id) && visit(n.id));
	const rank = new Map(nodes.map((n) => [n.id, 0]));
	let changed = true;
	for (let iter = 0; changed && iter < nodes.length + 1; iter++) {
		changed = false;
		for (const e of edges) {
			if (back.has(`${e.from}>${e.to}`) || !rank.has(e.to) || !rank.has(e.from)) continue;
			if (rank.get(e.to) < rank.get(e.from) + 1) {
				rank.set(e.to, rank.get(e.from) + 1);
				changed = true;
			}
		}
	}
	return { rank, back };
}

function autoPlace(nodes, edges, dir, info) {
	const missing = nodes.filter((n) => n.row === undefined || n.col === undefined);
	if (!missing.length) return;
	const { rank } = ranks(nodes, edges);
	const main = dir === "TB" ? "row" : "col";
	const cross = dir === "TB" ? "col" : "row";
	const taken = new Set(nodes.filter((n) => !missing.includes(n)).map((n) => `${n.row},${n.col}`));
	const preds = new Map(nodes.map((n) => [n.id, []]));
	for (const e of edges) preds.get(e.to)?.push(e.from);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	missing.sort((a, b) => rank.get(a.id) - rank.get(b.id));
	for (const n of missing) {
		n[main] = n[main] ?? rank.get(n.id);
		const ps = preds.get(n.id).map((p) => byId.get(p)).filter((p) => p[cross] !== undefined);
		let want = n[cross]
			?? (ps.length ? Math.round(ps.reduce((s, p) => s + p[cross], 0) / ps.length) : 0);
		for (let d = 0; d < 60; d++) {
			const cands = d === 0 ? [want] : [want + d, want - d].filter((v) => v >= 0);
			const hit = cands.find((c) => !taken.has(dir === "TB" ? `${n.row},${c}` : `${c},${n.col}`));
			if (hit !== undefined) {
				n[cross] = hit;
				break;
			}
		}
		taken.add(`${n.row},${n.col}`);
	}
	info.push({
		code: "I_AUTOPLACED",
		msg: `auto-placed ${missing.length} node(s)`,
		fix: "add row/col to control layout",
	});
}

export function render(input) {
	const spec = input.stages ? fromStages(input) : input;
	const problems = [];
	const info = [];
	const dir = spec.dir || (spec.type === "flowchart" || spec.variant === "vertical" ? "TB" : "LR");
	const laneIdx = new Map((spec.lanes || []).map((l, i) => [typeof l === "string" ? l : l.id, i]));
	const nodes = spec.nodes.map((n) => {
		const o = { ...n, kind: normalizeKind(n), shape: n.shape || DEFAULT_SHAPE[spec.type] || "box" };
		if (o.lane !== undefined && o.row === undefined) o.row = laneIdx.get(o.lane) ?? 0;
		return o;
	});
	nodes.forEach((n, i) => {
		if (n.label === undefined) {
			if (n.shape === "start" || n.shape === "end") n.label = n.shape === "start" ? "Start" : "End";
			else {problems.push({
					code: "E_SPEC",
					at: `nodes[${i}].label`,
					msg: "is required",
					fix: "add a label (only start/end shapes may omit it)",
				});}
		}
		if (n.lane !== undefined && !laneIdx.has(n.lane)) {
			problems.push({
				code: "E_LANE",
				at: `nodes[${i}]`,
				msg: `unknown lane "${n.lane}"`,
				fix: `use one of: ${[...laneIdx.keys()].join(", ")}`,
			});
		}
	});
	const ids = new Set();
	nodes.forEach((n, i) => {
		if (ids.has(n.id)) {
			problems.push({
				code: "E_DUP_ID",
				at: `nodes[${i}]`,
				msg: `duplicate id "${n.id}"`,
				fix: "ids must be unique",
			});
		}
		ids.add(n.id);
	});
	const allEdges = normEdges(spec, ids, problems).filter((e) => ids.has(e.from) && ids.has(e.to));
	const selfEdges = allEdges.filter((e) => e.self);
	const edges = allEdges.filter((e) => !e.self);
	if (problems.some((p) => p.code.startsWith("E_"))) return { problems };

	autoPlace(nodes, edges, dir, info);
	const cells = new Map();
	for (const n of nodes) {
		const key = `${n.row},${n.col}`;
		if (cells.has(key)) {
			problems.push({
				code: "E_CELL_TAKEN",
				at: `nodes.${n.id}`,
				msg: `row ${n.row} col ${n.col} already holds "${cells.get(key)}"`,
				fix: "give each node its own row/col",
			});
		}
		cells.set(key, n.id);
	}
	if (problems.length) return { problems };

	// focal budget
	const focal = nodes.filter((n) => n.kind === "focal");
	if (focal.length > 2) {
		problems.push({
			code: "W_FOCAL",
			at: "nodes",
			msg: `${focal.length} focal nodes`,
			fix: "keep the accent on 1–2 nodes; demote the rest to backend",
		});
	}
	const budget = spec.budget || TYPE_BUDGET[spec.type] || "balanced";
	const [maxN, maxE] = BUDGET[budget];
	if (nodes.length > maxN || edges.length > maxE) {
		problems.push({
			code: "W_BUDGET",
			at: "(root)",
			msg:
				`${nodes.length} nodes / ${edges.length} edges over the ${budget} budget (${maxN}/${maxE})`,
			fix:
				'merge nodes that travel together, split into overview + detail, or set budget:"faithful"',
		});
	}

	nodes.forEach((n) => sizeNode(n));

	// Grid geometry (compressed indices).
	const colIdx = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
	const rowIdx = [...new Set(nodes.map((n) => n.row))].sort((a, b) => a - b);
	const ci = new Map(colIdx.map((c, i) => [c, i]));
	const ri = new Map(rowIdx.map((r, i) => [r, i]));
	nodes.forEach((n) => {
		n.c = ci.get(n.col);
		n.r = ri.get(n.row);
	});
	const colW = colIdx.map((_, i) => Math.max(...nodes.filter((n) => n.c === i).map((n) => n.w)));
	const rowH = rowIdx.map((_, i) => Math.max(...nodes.filter((n) => n.r === i).map((n) => n.h)));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const grouped = (spec.groups && spec.groups.length) || nodes.some((n) => n.group);
	const extra = grouped ? GROUP_PAD * 2 : 0;
	const gapX = colIdx.slice(1).map(() => (dir === "TB" ? 64 : 72) + extra);
	const gapY = rowIdx.slice(1).map(() => (dir === "TB" ? 64 : 52) + extra);
	for (const e of edges) {
		if (!e.label) continue;
		const a = byId.get(e.from), b = byId.get(e.to);
		const need = labelBox(e.label).w + 28 + extra;
		if (a.c !== b.c) {
			// label will most likely sit in the gap next to the source column
			const g = Math.min(a.c, b.c);
			gapX[g] = Math.min(220, Math.max(gapX[g], need));
		} else {
			const g = Math.min(a.r, b.r);
			gapY[g] = Math.max(gapY[g], 40 + extra);
		}
	}
	const colX = [];
	let acc = 0;
	colW.forEach((w, i) => {
		colX.push(acc);
		acc += w + (gapX[i] || 0);
	});
	const rowY = [];
	acc = 0;
	rowH.forEach((h, i) => {
		rowY.push(acc);
		acc += h + (gapY[i] || 0);
	});
	for (const n of nodes) {
		n.x = colX[n.c] + (colW[n.c] - n.w) / 2;
		n.y = rowY[n.r] + (rowH[n.r] - n.h) / 2;
	}
	const lastX = colX[colX.length - 1] + colW[colW.length - 1];
	const lastY = rowY[rowY.length - 1] + rowH[rowH.length - 1];
	const channels = {
		xs: [-28 - extra / 2, ...gapX.map((g, i) => colX[i] + colW[i] + g / 2), lastX + 28 + extra / 2],
		ys: [-28 - extra / 2, ...gapY.map((g, i) => rowY[i] + rowH[i] + g / 2), lastY + 28 + extra / 2],
	};

	for (const e of edges) {
		for (const [end, fk, yk] of [["from", "fieldS", "fieldYS"], ["to", "fieldT", "fieldYT"]]) {
			if (!e[fk]) continue;
			const y = fieldY(byId.get(e[end]), e[fk]);
			if (y == null) {
				problems.push({
					code: "W_FIELD",
					at: `edges.${e.id}`,
					msg: `"${e[end]}" has no field "${e[fk]}"`,
					fix: "use a field name listed in that entity",
				});
			} else e[yk] = y;
		}
	}
	problems.push(...routeEdges(nodes, edges, { dir, channels }));
	// self loops (state machines): a small loop off the top-right corner
	for (const e of selfEdges) {
		const n = byId.get(e.from);
		const x0 = n.x + n.w * 0.7, y0 = n.y, x1 = n.x + n.w, y1 = n.y + Math.min(n.h * 0.4, 18);
		e.route = [{ x: x0, y: y0 }, { x: x0, y: y0 - 18 }, { x: x1 + 22, y: y0 - 18 }, {
			x: x1 + 22,
			y: y1,
		}, { x: x1, y: y1 }];
		edges.push(e);
	}

	// Groups.
	const groupDefs = new Map(
		(spec.groups || []).map((g) => [g.id, { ...g, members: new Set(g.nodes || []) }]),
	);
	for (const n of nodes) {
		if (!n.group) continue;
		if (!groupDefs.has(n.group)) {
			groupDefs.set(n.group, { id: n.group, label: n.group, members: new Set() });
		}
		groupDefs.get(n.group).members.add(n.id);
	}
	const groups = [];
	for (const g of groupDefs.values()) {
		const ms = [...g.members].map((id) => byId.get(id)).filter(Boolean);
		if (!ms.length) continue;
		const x0 = Math.min(...ms.map((n) => n.x)) - GROUP_PAD;
		const y0 = Math.min(...ms.map((n) => n.y)) - GROUP_TOP;
		const x1 = Math.max(...ms.map((n) => n.x + n.w)) + GROUP_PAD;
		const y1 = Math.max(...ms.map((n) => n.y + n.h)) + GROUP_PAD;
		const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
		for (const n of nodes) {
			if (g.members.has(n.id)) continue;
			if (n.x < box.x + box.w && n.x + n.w > box.x && n.y < box.y + box.h && n.y + n.h > box.y) {
				problems.push({
					code: "W_GROUP_OVERLAP",
					at: `groups.${g.id}`,
					msg: `"${n.id}" sits inside group "${g.id}"`,
					fix: `add "${n.id}" to the group or move it outside the group's rows/cols`,
				});
			}
		}
		const label = (g.label || g.id).toUpperCase();
		const lw = ceil4(textWidth(label, { size: 7, mono: true, tracking: 0.16 }) + 12);
		groups.push({ ...g, box, label, labelBox: { x: box.x + 12, y: box.y - 6, w: lw, h: 12 } });
	}

	// Labels.
	const obstacles = [
		...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
		...groups.map((g) => g.labelBox),
	];
	const placed = [];
	for (const e of edges) {
		if (!e.label || !e.route) continue;
		const box = placeLabel(
			e.route,
			e.label,
			obstacles,
			placed,
			edges.filter((o) => o !== e && o.route).map((o) => o.route),
		);
		if (box) {
			e.labelBox = box;
			placed.push(box);
		} else {
			problems.push({
				code: "W_LABEL",
				at: `edges.${e.id}`,
				msg: `label "${e.label}" has no clear spot`,
				fix: "shorten the label or move the nodes one row/col apart",
			});
		}
	}

	// Motion steps: BFS depth from sources (or explicit order).
	const { back } = ranks(nodes, edges);
	const depth = new Map();
	if (spec.order && spec.order.length) {
		spec.order.forEach((id, i) => depth.set(id, i));
	}
	const fwd = edges.filter((e) => !back.has(`${e.from}>${e.to}`));
	const indeg = new Map(nodes.map((n) => [n.id, 0]));
	fwd.forEach((e) => indeg.set(e.to, indeg.get(e.to) + 1));
	const queue = nodes.filter((n) => indeg.get(n.id) === 0 && !depth.has(n.id)).map((n) => n.id);
	queue.forEach((id) => depth.set(id, depth.get(id) ?? 0));
	for (let qi = 0; qi < queue.length; qi++) {
		const id = queue[qi];
		for (const e of fwd.filter((f) => f.from === id)) {
			if (!depth.has(e.to)) {
				depth.set(e.to, depth.get(id) + 1);
				queue.push(e.to);
			}
		}
	}
	nodes.forEach((n) => !depth.has(n.id) && depth.set(n.id, 0));
	const keys = [
		...nodes.map((n) => depth.get(n.id) * 2),
		...edges.map((e) => depth.get(e.from) * 2 + 1),
	];
	const steps = compressSteps(keys);
	nodes.forEach((n, i) => (n.step = steps[i]));
	edges.forEach((e, i) => (e.step = steps[nodes.length + i]));
	const maxStep = Math.max(1, ...steps);

	// Token chain for trace/loop.
	const chain = tokenChain(nodes, edges, byId);

	// Swimlane bands (one per lane, spanning its members' rows).
	const lanes = (spec.lanes || []).map((l, i) => {
		const id = typeof l === "string" ? l : l.id;
		const label = (typeof l === "string" ? l : l.label || l.id).toUpperCase();
		const ms = nodes.filter((n) => (n.lane !== undefined ? n.lane === id : n.row === i));
		if (!ms.length) return null;
		const r0 = Math.min(...ms.map((n) => n.r)), r1 = Math.max(...ms.map((n) => n.r));
		const above = r0 > 0 ? (gapY[r0 - 1] || 52) / 2 : 28;
		const below = r1 < rowH.length - 1 ? (gapY[r1] || 52) / 2 : 28;
		return { id, label, y0: rowY[r0] - above, y1: rowY[r1] + rowH[r1] + below, i };
	}).filter(Boolean);
	const laneGutter = lanes.length
		? Math.max(...lanes.map((l) => textWidth(l.label, { size: 8, mono: true, tracking: 0.16 })))
			+ 48
		: 0;

	// Bounds.
	const pts = [];
	lanes.forEach((l) => pts.push([-laneGutter - 8, l.y0], [lastX + 24, l.y1]));
	nodes.forEach((n) => pts.push([n.x, n.y], [n.x + n.w, n.y + n.h]));
	groups.forEach((g) => pts.push([g.box.x, g.labelBox.y], [g.box.x + g.box.w, g.box.y + g.box.h]));
	edges.forEach((e) => (e.route || []).forEach((p) => pts.push([p.x, p.y])));
	placed.forEach((b) => pts.push([b.x, b.y], [b.x + b.w, b.y + b.h]));
	const minX = Math.min(...pts.map((p) => p[0])) - 24;
	const minY = Math.min(...pts.map((p) => p[1])) - 24;
	const maxX = Math.max(...pts.map((p) => p[0])) + 24;
	let maxY = Math.max(...pts.map((p) => p[1])) + 16;

	// Legend.
	let legendSvg = "";
	const statuses = [...new Set(nodes.map((n) => n.status).filter(Boolean))];
	const changes = [...new Set(nodes.map((n) => n.change).filter(Boolean))];
	if (spec.legend !== false && (!NO_LEGEND.has(spec.type) || spec.legend === true)) {
		const nk = [...new Set(nodes.map((n) => n.kind))];
		const ek = [...new Set(edges.map((e) => e.kind))];
		if (nk.length + ek.length > 2 || spec.legend === true) {
			const extra = [
				...statuses.map((st) => ({
					type: "swatch",
					swatch: `st-${st}`,
					label: STATUS_NAMES[st] || st,
				})),
				...changes.map((c) => ({
					type: "text",
					label: { added: "+ New", removed: "− Removed", changed: "~ Changed" }[c],
				})),
			];
			const lg = legend({
				nodeKinds: nk,
				edgeKinds: (ek.length > 1 || ek[0] !== "default")
					? ek.filter((k) =>
						![
							"one-one",
							"one-many",
							"many-one",
							"many-many",
							"zero-many",
							"one-zero",
							"extends",
							"implements",
							"composes",
							"aggregates",
							"depends",
							"assoc",
							"line",
						].includes(k)
					)
					: [],
				extra,
				x: minX + 24,
				y: maxY + 8,
				w: maxX - minX - 48,
			});
			legendSvg = lg.svg;
			maxY += lg.h + 8;
		}
	}
	maxY += 24;

	const laneSvg = lanes.length
		? el(
			"g",
			{ class: "sc-lanes" },
			lanes.map((l) =>
				el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:0" }, [
					el("rect", {
						class: `lane-band${l.i % 2 ? " alt" : ""}`,
						x: minX + 16,
						y: l.y0,
						width: maxX - minX - 32,
						height: l.y1 - l.y0,
					}),
					el("line", { class: "lane-rule", x1: minX + 16, y1: l.y1, x2: maxX - 16, y2: l.y1 }),
					l.i === 0
						? el("line", { class: "lane-rule", x1: minX + 16, y1: l.y0, x2: maxX - 16, y2: l.y0 })
						: "",
					text({ class: "lane-label", x: minX + 28, y: (l.y0 + l.y1) / 2 + 3 }, l.label),
				])
			),
		)
		: "";
	const body = [
		laneSvg,
		el(
			"g",
			{ class: "sc-groups" },
			groups.map((g) =>
				el("g", {
					class: "sc-group sc-fade",
					"data-sc-group": g.id,
					"data-sc-step": 1,
					style: "--step:0",
				}, [
					el("rect", {
						class: `g-box${g.style === "dashed" ? " g-dashed" : ""}`,
						x: g.box.x,
						y: g.box.y,
						width: g.box.w,
						height: g.box.h,
						rx: 8,
					}),
					el("rect", {
						class: "g-label-bg",
						x: g.labelBox.x,
						y: g.labelBox.y,
						width: g.labelBox.w,
						height: 12,
					}),
					text({ class: "g-label", x: g.labelBox.x + 6, y: g.labelBox.y + 9 }, g.label),
				])
			),
		),
		el(
			"g",
			{ class: "sc-edges" },
			edges.filter((e) => e.route).map((e) =>
				drawEdge(e, { step: e.step, labelBoxAt: e.labelBox })
			),
		),
		// the flow token travels under the node layer, so it slips behind boxes instead of over them
		chain
			? el("circle", {
				class: "e-token",
				r: 3.2,
				"data-sc-step": maxStep,
				style: `--step:${maxStep};offset-path:path('${chain.d}');--tok-dur:${chain.dur}ms`,
			})
			: "",
		el("g", { class: "sc-nodes" }, nodes.map((n) => drawNode(n, { step: n.step }))),
		legendSvg,
	].join("");

	return {
		body,
		viewBox: [minX, minY, maxX - minX, maxY - minY],
		steps: maxStep,
		problems: [...problems, ...info],
		graph: {
			nodes: nodes.map((n) => ({
				id: n.id,
				label: n.label,
				...(n.group
					? { group: (groups.find((g) => g.id === n.group) || {}).label }
					: {}),
			})),
			edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
		},
	};
}

// One token traveling the primary path (primary edges, else source→focal).
function tokenChain(nodes, edges, byId) {
	let path = [];
	const prim = edges.filter((e) => e.kind === "primary" && e.route);
	if (prim.length) {
		const heads = prim.filter((e) => !prim.some((p) => p.to === e.from));
		let cur = heads[0] || prim[0];
		const used = new Set();
		while (cur && !used.has(cur.id) && path.length < 6) {
			used.add(cur.id);
			path.push(cur);
			cur = prim.find((p) => p.from === cur.to && !used.has(p.id));
		}
	} else {
		const focal = nodes.find((n) => n.kind === "focal");
		const routed = edges.filter((e) => e.route && e.kind !== "return" && e.kind !== "async");
		const sources = nodes.filter((n) => !routed.some((e) => e.to === n.id));
		for (const s of sources) {
			const prev = new Map([[s.id, null]]);
			const q = [s.id];
			while (q.length) {
				const id = q.shift();
				for (const e of routed.filter((r) => r.from === id)) {
					if (!prev.has(e.to)) {
						prev.set(e.to, e);
						q.push(e.to);
					}
				}
			}
			const target = focal && prev.has(focal.id) && focal.id !== s.id
				? focal.id
				: [...prev.keys()].pop();
			const p = [];
			for (let id = target; prev.get(id); id = prev.get(id).from) p.unshift(prev.get(id));
			if (p.length > path.length) path = p;
			if (focal && prev.has(focal.id)) break;
		}
		path = path.slice(0, 5);
	}
	if (!path.length) return null;
	const pts = [];
	for (const e of path) pts.push(...e.route);
	const d = path.map((e, i) => roundedPath(e.route, 7).replace(/^M/, i ? "L" : "M")).join(" ");
	const len = pts.reduce(
		(s, p, i) => (i ? s + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0),
		0,
	);
	return { d, dur: Math.round(Math.min(5200, Math.max(1600, len * 4.5))) };
}
