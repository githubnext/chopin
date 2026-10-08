// Sankey: columns by longest path, node heights ∝ flow, ribbons ordered to
// minimise crossings. Motion: columns appear left→right, ribbons wipe in.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { fmt } from "./scale.mjs";

export const family = "chart";

const NODE_W = 10;
const GAP = 16;
const H = 340;

export function render(spec) {
	const problems = [];
	const links = spec.links.map((
		l,
		i,
	) => (Array.isArray(l) ? { from: l[0], to: l[1], value: l[2], focal: l[3], i } : { ...l, i }));
	const meta = new Map((spec.nodes || []).map((n) => [n.id, n]));
	const nodes = new Map();
	const node = (id) => {
		if (!nodes.has(id)) {
			nodes.set(id, {
				id,
				label: meta.get(id)?.label || id,
				focal: !!meta.get(id)?.focal,
				col: meta.get(id)?.col,
				ins: [],
				outs: [],
			});
		}
		return nodes.get(id);
	};
	for (const l of links) {
		if (l.from === l.to) {
			problems.push({
				code: "E_SELF_EDGE",
				at: `links[${l.i}]`,
				msg: "self link",
				fix: "remove it",
			});
		}
		node(l.from).outs.push(l);
		node(l.to).ins.push(l);
	}
	if (problems.length) return { problems };
	const list = [...nodes.values()];
	if (list.length > 18) {
		problems.push({
			code: "W_BUDGET",
			at: "links",
			msg: `${list.length} nodes`,
			fix: 'merge small flows into "Other" (≤ 18 nodes)',
		});
	}

	// columns: longest path from sources (cycle-safe)
	const col = new Map(list.map((n) => [n.id, 0]));
	for (let k = 0; k < list.length; k++) {
		for (const l of links) {
			if (col.get(l.to) < col.get(l.from) + 1 && col.get(l.from) < list.length) {
				col.set(l.to, col.get(l.from) + 1);
			}
		}
	}
	const maxCol = Math.max(...col.values());
	for (const n of list) {
		n.c = n.col ?? (n.outs.length ? col.get(n.id) : maxCol);
		n.value = Math.max(
			n.ins.reduce((s, l) => s + l.value, 0),
			n.outs.reduce((s, l) => s + l.value, 0),
		);
	}
	const cols = [];
	list.forEach((n) => (cols[n.c] = cols[n.c] || []).push(n));
	for (let c = 0; c < cols.length; c++) cols[c] = cols[c] || [];
	const maxTotal = Math.max(...cols.map((cs) => cs.reduce((s, n) => s + n.value, 0) + 0));
	const maxN = Math.max(...cols.map((cs) => cs.length));
	const k = (H - GAP * (maxN - 1)) / maxTotal;

	const labelW = Math.max(...list.map((n) => textWidth(n.label, { size: 11, weight: 500 }))) + 56;
	const colGap = Math.max(140, labelW + 24);
	const stack = () => {
		for (const cs of cols) {
			const total = cs.reduce((s, n) => s + n.value * k, 0) + GAP * (cs.length - 1);
			let y = (H - total) / 2;
			for (const n of cs) {
				n.y = y;
				n.h = Math.max(2, n.value * k);
				y += n.h + GAP;
			}
		}
	};
	const center = (n) => n.y + n.h / 2;
	stack();
	for (let it = 0; it < 4; it++) {
		for (let c = 1; c < cols.length; c++) {
			const bc = (
				n,
			) => (n.ins.length
				? n.ins.reduce((s, l) => s + center(nodes.get(l.from)) * l.value, 0)
					/ n.ins.reduce((s, l) => s + l.value, 0)
				: center(n));
			cols[c].sort((a, b) => bc(a) - bc(b));
			stack();
		}
		for (let c = cols.length - 2; c >= 0; c--) {
			const bc = (
				n,
			) => (n.outs.length
				? n.outs.reduce((s, l) => s + center(nodes.get(l.to)) * l.value, 0)
					/ n.outs.reduce((s, l) => s + l.value, 0)
				: center(n));
			cols[c].sort((a, b) => bc(a) - bc(b));
			stack();
		}
	}
	for (const n of list) n.x = n.c * colGap;

	// ribbon offsets
	for (const n of list) {
		let o = n.y;
		for (const l of [...n.outs].sort((a, b) => center(nodes.get(a.to)) - center(nodes.get(b.to)))) {
			l.y0 = o;
			o += l.value * k;
		}
		let i = n.y;
		for (
			const l of [...n.ins].sort((a, b) => center(nodes.get(a.from)) - center(nodes.get(b.from)))
		) {
			l.y1 = i;
			i += l.value * k;
		}
	}
	const step = (c) => Math.min(12, 1 + c * 2);
	const unit = spec.unit || "";
	const ribbons = links.map((l) => {
		const s = nodes.get(l.from), t = nodes.get(l.to);
		const x0 = s.x + NODE_W, x1 = t.x, w = l.value * k;
		const mx = (x0 + x1) / 2;
		const d = `M${x0},${l.y0} C${mx},${l.y0} ${mx},${l.y1} ${x1},${l.y1} L${x1},${
			l.y1 + w
		} C${mx},${l.y1 + w} ${mx},${l.y0 + w} ${x0},${l.y0 + w} Z`;
		const focal = l.focal || s.focal || t.focal;
		const st = step(s.c) + 1;
		return el("path", {
			class: `sk-link sc-edge sc-wipe${focal ? " is-focal" : ""}`,
			d,
			"data-sc-edge": `l${l.i}`,
			"data-sc-step": st,
			style: `--step:${st}`,
			"data-sc-tip": `${s.label} → ${t.label}: ${fmt(l.value, unit)}`,
			"data-from": l.from,
			"data-to": l.to,
		});
	});
	const lastCol = cols.length - 1;
	const nodeSvg = list.map((n) => {
		// first column labels sit outside on the left, the rest to the right (haloed over ribbons)
		const first = n.c === 0 && lastCol > 0;
		const lx = first ? n.x - 8 : n.x + NODE_W + 8;
		const anchor = first ? "end" : "start";
		const st = step(n.c);
		return el("g", {
			class: "sc-node",
			"data-sc-node": n.id,
			"data-sc-step": st,
			style: `--step:${st}`,
			tabindex: 0,
			role: "group",
			"aria-label": `${n.label}, ${fmt(n.value, unit)}`,
		}, [
			el("rect", {
				class: `sk-node${n.focal ? " is-focal" : ""}`,
				x: n.x,
				y: n.y,
				width: NODE_W,
				height: n.h,
				rx: 1,
			}),
			text({ class: "sk-label", x: lx, y: center(n) - 1, "text-anchor": anchor }, n.label),
			text(
				{ class: "sk-val", x: lx, y: center(n) + 11, "text-anchor": anchor },
				fmt(n.value, unit),
			),
		]);
	});
	const firstW = Math.max(0, ...cols[0].map((n) => textWidth(n.label, { size: 11, weight: 500 })))
		+ 16;
	const lastW = Math.max(
		0,
		...cols[lastCol].map((n) =>
			Math.max(
				textWidth(n.label, { size: 11, weight: 500 }),
				textWidth(fmt(n.value, unit), { size: 9, mono: true }),
			)
		),
	) + 16;
	const W = (cols.length - 1) * colGap + NODE_W;
	return {
		body: el("g", { class: "sc-links" }, ribbons) + el("g", { class: "sc-nodes" }, nodeSvg),
		viewBox: [-firstW - 16, -32, W + firstW + lastW + 32, H + 64],
		steps: step(cols.length - 1) + 1,
		problems,
		graph: {
			nodes: list.map((n) => ({ id: n.id, label: n.label })),
			edges: links.map((l) => ({ id: `l${l.i}`, from: l.from, to: l.to })),
		},
	};
}
