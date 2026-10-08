// Waterfall (running total), treemap (squarified part-of-whole) and heatmap
// (two categorical axes, sequential colour).
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { fmt, niceDomain, ticks } from "./scale.mjs";

export const family = "chart";

export function renderWaterfall(spec) {
	const problems = [];
	const steps = spec.steps.map((s) => (Array.isArray(s) ? { label: s[0], value: s[1] } : { ...s }));
	let run = 0;
	const bars = steps.map((s, i) => {
		if (i === 0 && s.total === undefined && s.value >= 0) {
			run = s.value;
			return { ...s, from: 0, to: s.value, kind: "total" };
		}
		if (s.total) {
			const b = { ...s, from: 0, to: run, kind: "total" };
			return b;
		}
		const b = { ...s, from: run, to: run + s.value, kind: s.value >= 0 ? "up" : "down" };
		run += s.value;
		return b;
	});
	if (spec.end !== false && !steps[steps.length - 1].total) {
		bars.push({ label: spec.endLabel || "Total", from: 0, to: run, kind: "total" });
	}
	const vals = bars.flatMap((b) => [b.from, b.to]);
	const dom = niceDomain(Math.min(...vals), Math.max(...vals));
	const PH = 260;
	const slot = Math.max(54, Math.min(110, 640 / bars.length));
	const y = (v) => PH - ((v - dom.lo) / (dom.hi - dom.lo)) * PH;
	const unit = spec.unit || "";
	const out = [];
	for (const t of ticks(dom)) {
		out.push(
			el("line", {
				class: t === 0 ? "ax-line" : "ax-grid",
				x1: 0,
				y1: y(t),
				x2: slot * bars.length,
				y2: y(t),
			}),
		);
		out.push(text({ class: "ax-text", x: -8, y: y(t) + 3, "text-anchor": "end" }, fmt(t, unit)));
	}
	bars.forEach((b, i) => {
		const x = i * slot + slot * 0.18, w = slot * 0.64;
		const top = y(Math.max(b.from, b.to)), bot = y(Math.min(b.from, b.to));
		const st = Math.min(12, 1 + i);
		out.push(el("rect", {
			class: `wf-bar wf-${b.kind}${b.focal ? " is-focal" : ""} sc-grow-y`,
			x,
			y: top,
			width: w,
			height: Math.max(1, bot - top),
			rx: 1.5,
			"data-sc-step": st,
			style: `--step:${st}${b.kind === "down" ? ";transform-origin:50% 0" : ""}`,
			"data-sc-tip": `${b.label}: ${
				b.kind === "total" ? fmt(b.to, unit) : (b.value > 0 ? "+" : "") + fmt(b.value, unit)
			}`,
		}));
		if (i < bars.length - 1 && bars[i + 1].kind !== "total") {
			out.push(
				el("line", {
					class: "wf-link sc-fade",
					x1: x + w,
					y1: y(b.to),
					x2: x + slot,
					y2: y(b.to),
					"data-sc-step": st,
					style: `--step:${st}`,
				}),
			);
		}
		const lab = b.kind === "total"
			? fmt(b.to, unit)
			: `${b.value > 0 ? "+" : ""}${fmt(b.value, unit)}`;
		out.push(
			text({
				class: `c-val sc-fade${b.focal ? " is-focal" : ""}`,
				x: x + w / 2,
				y: top - 6,
				"text-anchor": "middle",
				"data-sc-step": st,
				style: `--step:${st}`,
			}, lab),
		);
		out.push(text({ class: "c-cat", x: x + w / 2, y: PH + 18, "text-anchor": "middle" }, b.label));
	});
	return {
		body: out.join(""),
		viewBox: [-56, -28, slot * bars.length + 72, PH + 56],
		steps: Math.min(12, bars.length),
		problems,
	};
}

// Squarified treemap (Bruls et al.), recursive on optional children.
function squarify(items, x, y, w, h) {
	const total = items.reduce((s, i) => s + i.value, 0);
	const scale = (w * h) / total;
	const nodes = items.map((i) => ({ ...i, area: i.value * scale })).sort((a, b) => b.area - a.area);
	const out = [];
	let rect = { x, y, w, h };
	let row = [];
	const worst = (r, side) => {
		const s = r.reduce((a, n) => a + n.area, 0);
		const mx = Math.max(...r.map((n) => n.area)), mn = Math.min(...r.map((n) => n.area));
		return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
	};
	const layoutRow = (r) => {
		const s = r.reduce((a, n) => a + n.area, 0);
		if (rect.w >= rect.h) {
			const cw = s / rect.h;
			let cy = rect.y;
			for (const n of r) {
				const ch = n.area / cw;
				out.push({ ...n, x: rect.x, y: cy, w: cw, h: ch });
				cy += ch;
			}
			rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
		} else {
			const ch = s / rect.w;
			let cx = rect.x;
			for (const n of r) {
				const cw = n.area / ch;
				out.push({ ...n, x: cx, y: rect.y, w: cw, h: ch });
				cx += cw;
			}
			rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
		}
	};
	for (const n of nodes) {
		const side = Math.min(rect.w, rect.h);
		if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
		else {
			layoutRow(row);
			row = [n];
		}
	}
	if (row.length) layoutRow(row);
	return out;
}

export function renderTreemap(spec) {
	const problems = [];
	const norm = (
		d,
	) => (Array.isArray(d)
		? { label: d[0], value: d[1] }
		: {
			...d,
			value: d.value
				?? (d.children || []).reduce((s, c) => s + (Array.isArray(c) ? c[1] : c.value), 0),
		});
	const items = spec.data.map(norm).filter((d) => d.value > 0);
	if (items.length > 24) {
		problems.push({
			code: "W_BUDGET",
			at: "data",
			msg: `${items.length} cells`,
			fix: 'fold the smallest into "Other" (≤ 24 cells)',
		});
	}
	const W = 640, H = 380;
	const total = items.reduce((s, i) => s + i.value, 0);
	const out = [];
	const cells = squarify(items, 0, 0, W, H);
	const focalSet = new Set([].concat(spec.focal || []));
	cells.forEach((c, k) => {
		const st = Math.min(12, 1 + k);
		const focal = c.focal || focalSet.has(c.label);
		const parts = [
			el("rect", {
				class: `tm-cell${focal ? " is-focal" : ""}`,
				x: c.x + 1,
				y: c.y + 1,
				width: Math.max(0, c.w - 2),
				height: Math.max(0, c.h - 2),
				rx: 2,
			}),
		];
		if (c.children && c.children.length) {
			for (const sub of squarify(c.children.map(norm), c.x + 4, c.y + 20, c.w - 8, c.h - 24)) {
				parts.push(
					el("rect", {
						class: "tm-sub",
						x: sub.x + 1,
						y: sub.y + 1,
						width: Math.max(0, sub.w - 2),
						height: Math.max(0, sub.h - 2),
						rx: 1.5,
						"data-sc-tip": `${c.label} › ${sub.label}: ${fmt(sub.value, spec.unit || "")}`,
					}),
				);
				if (sub.w > textWidth(sub.label, { size: 9.5 }) + 10 && sub.h > 18) {
					parts.push(text({ class: "tm-sub-label", x: sub.x + 6, y: sub.y + 14 }, sub.label));
				}
			}
		}
		const fitsLabel = c.w > textWidth(c.label, { size: 11, weight: 600 }) + 14 && c.h > 30;
		if (fitsLabel) {
			parts.push(
				text({ class: `tm-label${focal ? " is-focal" : ""}`, x: c.x + 8, y: c.y + 17 }, c.label),
			);
			if (!c.children && c.h > 44) {
				parts.push(
					text(
						{ class: `tm-val${focal ? " is-focal" : ""}`, x: c.x + 8, y: c.y + 31 },
						`${fmt(c.value, spec.unit || "")} · ${Math.round((c.value / total) * 100)}%`,
					),
				);
			}
		} else if (c.w < 10 || c.h < 10) {
			problems.push({
				code: "I_TINY",
				msg: `"${c.label}" is too small to label`,
				fix: 'fold it into "Other"',
			});
		}
		out.push(el("g", {
			class: "sc-node sc-fade",
			"data-sc-node": `c${k}`,
			"data-sc-step": st,
			style: `--step:${st}`,
			"data-sc-tip": `${c.label}: ${fmt(c.value, spec.unit || "")}`,
			tabindex: 0,
			role: "group",
			"aria-label": `${c.label} ${c.value}`,
		}, parts));
	});
	return {
		body: out.join(""),
		viewBox: [-16, -16, W + 32, H + 32],
		steps: Math.min(12, cells.length),
		problems,
		graph: { nodes: cells.map((c, k) => ({ id: `c${k}`, label: c.label })), edges: [] },
	};
}

export function renderHeatmap(spec) {
	const problems = [];
	const { rows, cols, values } = spec;
	if (values.length !== rows.length || values.some((r) => r.length !== cols.length)) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "values",
				msg: `values must be ${rows.length}×${cols.length}`,
				fix: "one row of numbers per row label",
			}],
		};
	}
	const flat = values.flat().filter((v) => v != null);
	const lo = spec.min ?? Math.min(...flat), hi = spec.max ?? Math.max(...flat);
	const diverging = spec.scale === "diverging" || (lo < 0 && hi > 0);
	const rowW = Math.max(...rows.map((r) => textWidth(r, { size: 10 }))) + 16;
	const cw = Math.max(28, Math.min(64, 560 / cols.length)),
		ch = Math.max(22, Math.min(34, 360 / rows.length));
	const out = [];
	cols.forEach((c, j) =>
		out.push(
			text({ class: "ax-text", x: rowW + j * cw + cw / 2, y: -8, "text-anchor": "middle" }, c),
		)
	);
	rows.forEach((r, i) => {
		const st = Math.min(12, 1 + i);
		const parts = [
			text({ class: "c-cat", x: rowW - 8, y: i * ch + ch / 2 + 4, "text-anchor": "end" }, r),
		];
		values[i].forEach((v, j) => {
			if (v == null) return;
			let t, cls;
			if (diverging) {
				const m = Math.max(Math.abs(lo), Math.abs(hi));
				t = Math.abs(v) / m;
				cls = v >= 0 ? "hm-pos" : "hm-neg";
			} else {
				t = (v - lo) / (hi - lo || 1);
				cls = "hm-pos";
			}
			parts.push(
				el("rect", {
					class: `hm-cell ${cls}`,
					x: rowW + j * cw + 1,
					y: i * ch + 1,
					width: cw - 2,
					height: ch - 2,
					rx: 2,
					"fill-opacity": (0.06 + t * 0.88).toFixed(2),
					"data-sc-tip": `${r} · ${cols[j]}: ${fmt(v, spec.unit || "")}`,
				}),
			);
			if (spec.labels !== false && cw >= 34) {
				parts.push(
					text({
						class: `hm-val${t > 0.6 ? " on-dark" : ""}`,
						x: rowW + j * cw + cw / 2,
						y: i * ch + ch / 2 + 3.5,
						"text-anchor": "middle",
					}, fmt(v, spec.unit || "")),
				);
			}
		});
		out.push(el("g", { class: "sc-fade", "data-sc-step": st, style: `--step:${st}` }, parts));
	});
	return {
		body: out.join(""),
		viewBox: [-16, -28, rowW + cols.length * cw + 32, rows.length * ch + 48],
		steps: Math.min(12, rows.length),
		problems,
	};
}
