// Scatter family: scatter (x,y), bubble (x,y,size) and beeswarm (one value
// axis, points packed to avoid overlap, grouped by category).
import { el, text } from "../../svg.mjs";
import { fmt, niceDomain, ticks } from "./scale.mjs";

export const family = "chart";

const PW = 520, PH = 320;

export function render(spec) {
	const problems = [];
	const v = spec.variant || "scatter";
	const pts = spec.points.map((
		p,
		i,
	) => (Array.isArray(p) ? { label: p[0], x: p[1], y: p[2], size: p[3] } : { ...p })).map((
		p,
		i,
	) => ({ ...p, i }));
	if (pts.length > 200) {
		problems.push({
			code: "W_BUDGET",
			at: "points",
			msg: `${pts.length} points`,
			fix: "sample or aggregate to ≤ 200 points",
		});
	}
	const out = [];
	const unitX = spec.unitX || "", unitY = spec.unitY || spec.unit || "";
	const labelled = pts.filter((p) => p.focal || p.label && pts.length <= 12);

	if (v === "beeswarm") {
		const groups = [...new Set(pts.map((p) => p.group || ""))];
		const dom = niceDomain(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)));
		const x = (val) => ((val - dom.lo) / (dom.hi - dom.lo)) * PW;
		const band = Math.max(70, Math.min(110, 360 / groups.length));
		for (const t of ticks(dom)) {
			out.push(
				el("line", { class: "ax-grid", x1: x(t), y1: -10, x2: x(t), y2: groups.length * band }),
			);
			out.push(
				text(
					{ class: "ax-text", x: x(t), y: groups.length * band + 16, "text-anchor": "middle" },
					fmt(t, unitX),
				),
			);
		}
		const r = 4.5;
		groups.forEach((g, gi) => {
			const cy = gi * band + band / 2;
			if (g) out.push(text({ class: "c-cat", x: -12, y: cy + 4, "text-anchor": "end" }, g));
			const placed = [];
			pts.filter((p) => (p.group || "") === g).sort((a, b) => a.x - b.x).forEach((p) => {
				const px = x(p.x);
				let best = 0;
				for (let k = 0; k < 40; k++) {
					const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (r * 2 + 0.6);
					if (!placed.some((q) => Math.hypot(q.x - px, q.y - (cy + off)) < r * 2 + 0.5)) {
						best = off;
						break;
					}
				}
				p.px = px;
				p.py = cy + best;
				placed.push({ x: px, y: p.py });
			});
		});
		pts.forEach((p) => {
			const st = Math.min(12, 1 + Math.floor((p.px / PW) * 11));
			out.push(
				el("circle", {
					class: `sp-dot sc-pop${p.focal ? " is-focal" : ""}`,
					cx: p.px,
					cy: p.py,
					r,
					"data-sc-step": st,
					style: `--step:${st}`,
					"data-sc-tip": `${p.label || ""} ${fmt(p.x, unitX)}`.trim(),
				}),
			);
			if (p.focal && p.label) {
				out.push(text({ class: "sp-label is-focal-t", x: p.px + 8, y: p.py - 8 }, p.label));
			}
		});
		if (spec.xLabel) {
			out.push(
				text({
					class: "ax-label",
					x: PW / 2,
					y: groups.length * band + 36,
					"text-anchor": "middle",
				}, spec.xLabel),
			);
		}
		return {
			body: out.join(""),
			viewBox: [-120, -24, PW + 150, groups.length * band + 64],
			steps: 12,
			problems,
		};
	}

	const dx = niceDomain(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)));
	const dy = niceDomain(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)));
	if (spec.zero === false) {
		for (const [d, key] of [[dx, "x"], [dy, "y"]]) {
			const lo = Math.min(...pts.map((p) => p[key]));
			d.lo = Math.max(d.lo, Math.floor(lo / d.step) * d.step - d.step);
		}
	}
	const x = (val) => ((val - dx.lo) / (dx.hi - dx.lo)) * PW;
	const y = (val) => PH - ((val - dy.lo) / (dy.hi - dy.lo)) * PH;
	for (const t of ticks(dx)) {
		if (t < dx.lo) continue;
		out.push(el("line", { class: "ax-grid", x1: x(t), y1: 0, x2: x(t), y2: PH }));
		out.push(
			text({ class: "ax-text", x: x(t), y: PH + 16, "text-anchor": "middle" }, fmt(t, unitX)),
		);
	}
	for (const t of ticks(dy)) {
		if (t < dy.lo) continue;
		out.push(el("line", { class: "ax-grid", x1: 0, y1: y(t), x2: PW, y2: y(t) }));
		out.push(text({ class: "ax-text", x: -8, y: y(t) + 3, "text-anchor": "end" }, fmt(t, unitY)));
	}
	out.push(el("line", { class: "ax-line", x1: 0, y1: PH, x2: PW, y2: PH }));
	if (spec.xLabel) {
		out.push(
			text({ class: "ax-label", x: PW / 2, y: PH + 36, "text-anchor": "middle" }, spec.xLabel),
		);
	}
	if (spec.yLabel) out.push(text({ class: "ax-label", x: 0, y: -12 }, spec.yLabel));
	const maxSize = Math.max(1, ...pts.map((p) => p.size || 0));
	const radius = (
		p,
	) => (v === "bubble" ? 4 + Math.sqrt((p.size || 0) / maxSize) * 26 : p.focal ? 5.5 : 4);
	const order = [...pts].sort((a, b) => radius(b) - radius(a));
	order.forEach((p, k) => {
		const st = Math.min(12, 1 + Math.floor((k * 11) / Math.max(11, pts.length)));
		out.push(el("circle", {
			class: `sp-dot sc-pop${p.focal ? " is-focal" : ""}${v === "bubble" ? " is-bubble" : ""}`,
			cx: x(p.x),
			cy: y(p.y),
			r: radius(p),
			"data-sc-step": st,
			style: `--step:${st}`,
			"data-sc-tip": `${p.label ? `${p.label}: ` : ""}${fmt(p.x, unitX)}, ${fmt(p.y, unitY)}${
				p.size ? ` · ${fmt(p.size)}` : ""
			}`,
		}));
	});
	labelled.forEach((p) => {
		const right = x(p.x) < PW - 90;
		out.push(
			text({
				class: `sp-label sc-fade${p.focal ? " is-focal-t" : ""}`,
				x: x(p.x) + (right ? radius(p) + 5 : -radius(p) - 5),
				y: y(p.y) + 3.5,
				"text-anchor": right ? "start" : "end",
				"data-sc-step": 12,
				style: "--step:12",
			}, p.label),
		);
	});
	return { body: out.join(""), viewBox: [-56, -32, PW + 90, PH + 76], steps: 12, problems };
}
