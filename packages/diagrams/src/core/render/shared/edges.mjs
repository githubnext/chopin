// Edge drawing + label placement shared by graph-like renderers.
import { el, esc, roundedPath, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { rectsOverlap } from "../../svg.mjs";
import { DIAGRAM_TYPE, LABEL_BOX } from "../../tokens.mjs";

export const EDGE_LABEL = DIAGRAM_TYPE.edge;
const HEAD = 8;

export function labelBox(label) {
	return {
		w: ceil4(textWidth(label, EDGE_LABEL) + LABEL_BOX.badgePaddingInline * 2),
		h: EDGE_LABEL.lineHeight + LABEL_BOX.badgePaddingBlock * 2,
	};
}

function unit(a, b) {
	const dx = b.x - a.x, dy = b.y - a.y;
	const l = Math.hypot(dx, dy) || 1;
	return { x: dx / l, y: dy / l };
}

function headAt(tip, d) {
	const bx = tip.x - d.x * HEAD, by = tip.y - d.y * HEAD;
	const px = -d.y * 3.2, py = d.x * 3.2;
	return `M${tip.x},${tip.y} L${bx + px},${by + py} L${bx - px},${by - py} Z`;
}

// Place a label on a route avoiding obstacles. Returns {x,y,w,h} or null.
export function placeLabel(route, label, obstacles, placed, others = []) {
	const { w, h } = labelBox(label);
	const segs = [];
	for (let i = 1; i < route.length; i++) {
		const a = route[i - 1], b = route[i];
		const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
		const horiz = a.y === b.y;
		// prefer horizontal segments that can hold the label, then long vertical ones
		const fits = horiz ? len >= w + 12 : len >= h + 16;
		const stub = i === 1 || i === route.length - 1;
		segs.push({
			a,
			b,
			len,
			horiz,
			score: (fits ? 0 : 1000) + (horiz ? 0 : 60) + (stub && route.length > 2 ? 40 : 0) - len * 0.5,
		});
	}
	segs.sort((s1, s2) => s1.score - s2.score);
	for (const s of segs) {
		// on the line first; then beside it (vertical runs) or just above it (horizontal runs)
		let offsets = s.horiz
			? [[0, 0], [0, -10], [0, 10]]
			: [[0, 0], [-(w / 2 + 5), 0], [w / 2 + 5, 0]];
		if (!s.horiz) {
			// a close parallel run (e.g. a two-way pair): sit on the outer side, away from it
			const lo = Math.min(s.a.y, s.b.y), hi = Math.max(s.a.y, s.b.y);
			const near = others.flatMap((r) => r.slice(1).map((q, i) => [r[i], q]))
				.find(([p, q]) =>
					p.x === q.x && p.x !== s.a.x && Math.abs(p.x - s.a.x) < 30 && Math.max(p.y, q.y) > lo
					&& Math.min(p.y, q.y) < hi
				);
			if (near) {
				offsets = near[0].x > s.a.x
					? [[-(w / 2 + 5), 0], [0, 0]]
					: [[w / 2 + 5, 0], [0, 0]];
			}
		}
		for (const [dx, dy] of offsets) {
			for (const t of [0.5, 0.35, 0.65, 0.25, 0.75]) {
				const cx = s.a.x + (s.b.x - s.a.x) * t + dx, cy = s.a.y + (s.b.y - s.a.y) * t + dy;
				const box = { x: cx - w / 2, y: cy - h / 2, w, h };
				if (obstacles.some((o) => rectsOverlap(box, o, 2))) continue;
				if (placed.some((o) => rectsOverlap(box, o, 3))) continue;
				return box;
			}
		}
	}
	return null;
}

// End decorations per edge kind (arrows, ER cardinality, UML relations).
export const KIND_ENDS = {
	default: { end: "arrow" },
	primary: { end: "arrow" },
	link: { end: "arrow" },
	muted: { end: "arrow" },
	async: { end: "arrow", dashed: true },
	return: { end: "arrow", dashed: true },
	"one-one": { start: "one", end: "one", rel: true },
	"one-many": { start: "one", end: "many", rel: true },
	"many-one": { start: "many", end: "one", rel: true },
	"many-many": { start: "many", end: "many", rel: true },
	"zero-many": { start: "one", end: "zero-many", rel: true },
	"one-zero": { start: "one", end: "zero-one", rel: true },
	extends: { end: "triangle", rel: true },
	implements: { end: "triangle", dashed: true, rel: true },
	composes: { start: "diamond-filled", rel: true },
	aggregates: { start: "diamond", rel: true },
	depends: { end: "open", dashed: true, rel: true },
	assoc: { rel: true },
	line: {},
};
const GLYPH_LEN = {
	arrow: HEAD - 1,
	triangle: 12,
	diamond: 16,
	"diamond-filled": 16,
	open: 0,
	one: 0,
	many: 0,
	"zero-many": 0,
	"zero-one": 0,
};

// Glyph at endpoint p, d = unit direction pointing INTO the node.
function glyph(type, p, d, kind) {
	const px = -d.y, py = d.x;
	const at = (back, side) => ({ x: p.x - d.x * back + px * side, y: p.y - d.y * back + py * side });
	const P = (pts) => pts.map((q, i) => `${i ? "L" : "M"}${q.x},${q.y}`).join(" ");
	switch (type) {
		case "arrow":
			return el("path", {
				class: `e-head m-${["async", "return"].includes(kind) ? "default" : kind}`,
				d: headAt(p, d),
			});
		case "triangle":
			return el("path", { class: "e-glyph hollow", d: `${P([p, at(12, 7), at(12, -7)])} Z` });
		case "diamond":
		case "diamond-filled":
			return el("path", {
				class: `e-glyph ${type === "diamond" ? "hollow" : "filled"}`,
				d: `${P([p, at(8, 5), at(16, 0), at(8, -5)])} Z`,
			});
		case "open":
			return el("path", { class: "e-glyph stroke", d: P([at(9, 5), p, at(9, -5)]) });
		case "one":
			return el("path", {
				class: "e-glyph stroke",
				d: `${P([at(7, 6), at(7, -6)])} ${P([at(11, 6), at(11, -6)])}`,
			});
		case "many":
		case "zero-many":
			return el("path", {
				class: "e-glyph stroke",
				d: `${P([at(12, 0), at(0, 6)])} ${P([at(12, 0), at(0, -6)])} ${P([at(12, 0), at(0, 0)])} ${
					type === "many" ? P([at(15, 6), at(15, -6)]) : ""
				}`,
			})
				+ (type === "zero-many"
					? el("circle", { class: "e-glyph hollow", cx: at(18, 0).x, cy: at(18, 0).y, r: 3.5 })
					: "");
		case "zero-one":
			return el("path", { class: "e-glyph stroke", d: P([at(8, 6), at(8, -6)]) })
				+ el("circle", { class: "e-glyph hollow", cx: at(15, 0).x, cy: at(15, 0).y, r: 3.5 });
		default:
			return "";
	}
}

export function drawEdge(e, { step, labelBoxAt } = {}) {
	const kind = e.kind || "default";
	const ends = KIND_ENDS[kind] || KIND_ENDS.default;
	const endG = ends.end || (e.both ? "arrow" : null);
	const startG = ends.start || (e.both ? "arrow" : null);
	const pts = e.route.map((p) => ({ ...p }));
	const n = pts.length;
	const dEnd = unit(pts[n - 2], pts[n - 1]);
	const dStart = unit(pts[1], pts[0]);
	const tip = { ...e.route[n - 1] };
	const tail = { ...e.route[0] };
	if (endG) {
		pts[n - 1] = { x: tip.x - dEnd.x * GLYPH_LEN[endG], y: tip.y - dEnd.y * GLYPH_LEN[endG] };
	}
	if (startG) {
		pts[0] = { x: tail.x - dStart.x * GLYPH_LEN[startG], y: tail.y - dStart.y * GLYPH_LEN[startG] };
	}
	const d = roundedPath(pts, 7);
	const dashed = !!ends.dashed;
	const parts = [
		el("path", {
			class: `e-line${dashed ? " dashed" : " sc-draw"}`,
			d,
			pathLength: dashed ? undefined : 1,
		}),
	];
	if (endG) parts.push(glyph(endG, tip, dEnd, kind));
	if (startG) parts.push(glyph(startG, tail, dStart, kind));
	if (e.label && labelBoxAt) {
		const b = labelBoxAt;
		parts.push(el("g", { class: "e-label-g" }, [
			el("rect", { class: "e-label-bg", x: b.x, y: b.y, width: b.w, height: b.h, rx: 2 }),
			text({
				class: "e-label",
				x: b.x + b.w / 2,
				y: b.y + b.h / 2,
				"text-anchor": "middle",
				"dominant-baseline": "central",
			}, e.label),
		]));
	}
	return el("g", {
		class: `sc-edge ek-${ends.rel ? "rel" : kind}${e.change ? ` ch-${e.change}` : ""}`,
		"data-sc-edge": e.id,
		"data-from": e.from,
		"data-to": e.to,
		"data-sc-step": step,
		style: step ? `--step:${step}` : undefined,
	}, parts);
}

export { esc };
