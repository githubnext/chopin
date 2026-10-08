// Line family: line (default), slope (two points per series), bump (rank
// over time, inverted axis), stream (stacked, centred areas) and ridgeline
// (one small area per series, offset vertically). The focal series gets the
// accent; others are muted unless series colours are needed.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { fmt, niceDomain, ticks } from "./scale.mjs";

export const family = "chart";

const PW = 560, PH = 260;

function smooth(pts) {
	if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
	let d = `M${pts[0].x},${pts[0].y}`;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i];
		const mx = (a.x + b.x) / 2;
		d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
	}
	return d;
}

export function render(spec) {
	const problems = [];
	const v = spec.variant || "line";
	const xs = spec.x || spec.categories;
	const series = spec.series.map((s, i) => ({ ...s, i }));
	if (!xs || !xs.length) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "x",
				msg: "needs x labels",
				fix: 'add "x":["Jan","Feb",…] (one per value)',
			}],
		};
	}
	series.forEach((s) => {
		if (s.values.length !== xs.length) {
			problems.push({
				code: "E_SERIES_LEN",
				at: `series[${s.i}]`,
				msg: `${s.values.length} values for ${xs.length} x labels`,
				fix: "give one value per x label (use null for gaps)",
			});
		}
	});
	if (problems.length) return { problems };
	if (series.length > 6 && v !== "ridgeline") {
		problems.push({
			code: "W_BUDGET",
			at: "series",
			msg: `${series.length} series`,
			fix: 'highlight ≤ 5 series; fold the rest into "Other"',
		});
	}
	const anyFocal = series.some((s) => s.focal);
	const unit = spec.unit || "";
	const out = [];
	const xAt = (i) => (xs.length === 1 ? PW / 2 : (i * PW) / (xs.length - 1));
	const cls = (
		s,
	) => (s.focal ? "ln is-focal" : anyFocal ? "ln is-muted" : `ln ln-${(s.i % 5) + 1}`);
	const lblCls = (
		s,
	) => (s.focal ? "is-focal-t" : anyFocal ? "is-muted-t" : `ln-${(s.i % 5) + 1}-t`);
	const labelW = Math.max(...series.map((s) => textWidth(s.name, { size: 10, weight: 500 }))) + 50;

	if (v === "ridgeline") {
		const rowH = 46;
		const max = Math.max(...series.flatMap((s) => s.values.filter((x) => x != null)));
		series.forEach((s, k) => {
			const base = k * rowH + 60;
			const pts = s.values.map((val, i) => ({ x: xAt(i), y: base - ((val ?? 0) / max) * 70 }));
			const area = `${smooth(pts)} L${PW},${base} L0,${base} Z`;
			const st = Math.min(12, k + 1);
			out.push(
				el("g", {
					class: `sc-node ${s.focal ? "k-focal" : ""}`,
					"data-sc-node": `s${k}`,
					"data-sc-step": st,
					style: `--step:${st}`,
					tabindex: 0,
					role: "group",
					"aria-label": s.name,
				}, [
					el("path", {
						class: `rg-area${s.focal ? " is-focal" : ""} sc-wipe`,
						d: area,
						"data-sc-step": st,
						style: `--step:${st}`,
					}),
					el("path", { class: `rg-line${s.focal ? " is-focal" : ""}`, d: smooth(pts) }),
					text({
						class: `c-cat${s.focal ? " is-focal-t" : ""}`,
						x: -10,
						y: base - 4,
						"text-anchor": "end",
					}, s.name),
				]),
			);
		});
		xs.forEach((x, i) =>
			(i % Math.ceil(xs.length / 8) === 0)
			&& out.push(
				text(
					{ class: "ax-text", x: xAt(i), y: series.length * rowH + 76, "text-anchor": "middle" },
					x,
				),
			)
		);
		return {
			body: out.join(""),
			viewBox: [-labelW - 10, -24, PW + labelW + 40, series.length * rowH + 110],
			steps: Math.min(12, series.length),
			problems,
			graph: { nodes: series.map((s, k) => ({ id: `s${k}`, label: s.name })), edges: [] },
		};
	}

	let y, dom;
	if (v === "bump") {
		const n = series.length;
		y = (rank) => ((rank - 1) / Math.max(1, n - 1)) * PH;
		for (let r = 1; r <= n; r++) {
			out.push(text({ class: "ax-text", x: -10, y: y(r) + 3, "text-anchor": "end" }, `#${r}`));
		}
	} else if (v === "stream") {
		const totals = xs.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
		const max = Math.max(...totals);
		y = (val) => PH / 2 - (val / max) * (PH / 2);
		const lo = xs.map((_, i) => -totals[i] / 2);
		series.forEach((s, k) => {
			const top = xs.map((_, i) => lo[i] + (s.values[i] ?? 0));
			const up = top.map((t, i) => ({ x: xAt(i), y: PH / 2 - (t / max) * PH }));
			const dn = lo.map((t, i) => ({ x: xAt(i), y: PH / 2 - (t / max) * PH })).toReversed();
			const d = `${smooth(up)} L${dn[0].x},${dn[0].y} ${smooth(dn).replace(/^M[^ ]+ /, "")} Z`;
			const st = Math.min(12, k + 1);
			out.push(
				el("path", {
					class: `st-area ${s.focal ? "is-focal" : `s-${(k % 5) + 1}`} sc-wipe`,
					d,
					"data-sc-step": st,
					style: `--step:${st}`,
					"data-sc-tip": s.name,
				}),
			);
			const mid = Math.floor(xs.length / 2);
			if ((s.values[mid] ?? 0) / max > 0.08) {
				out.push(
					text({
						class: "st-label",
						x: xAt(mid),
						y: PH / 2 - ((lo[mid] + (s.values[mid] ?? 0) / 2) / max) * PH + 4,
						"text-anchor": "middle",
					}, s.name),
				);
			}
			lo.forEach((_, i) => {
				lo[i] = top[i];
			});
		});
		xs.forEach((x, i) =>
			(i % Math.ceil(xs.length / 8) === 0)
			&& out.push(text({ class: "ax-text", x: xAt(i), y: PH + 18, "text-anchor": "middle" }, x))
		);
		return {
			body: out.join(""),
			viewBox: [-24, -24, PW + 48, PH + 56],
			steps: Math.min(12, series.length),
			problems,
			graph: { nodes: [], edges: [] },
		};
	} else {
		dom = niceDomain(
			Math.min(...series.flatMap((s) => s.values.filter((x) => x != null))),
			Math.max(...series.flatMap((s) => s.values.filter((x) => x != null))),
		);
		if (spec.zero === false) {
			const vals = series.flatMap((s) => s.values.filter((x) => x != null));
			const lo = Math.min(...vals), hi = Math.max(...vals), p = (hi - lo) * 0.1 || 1;
			dom = niceDomain(lo - p, hi + p);
			dom.lo = Math.max(dom.lo, Math.floor((lo - p) / dom.step) * dom.step);
		}
		y = (val) => PH - ((val - dom.lo) / (dom.hi - dom.lo)) * PH;
		if (v !== "slope") {
			for (const t of ticks(dom)) {
				if (t < dom.lo) continue;
				out.push(
					el("line", { class: t === 0 ? "ax-line" : "ax-grid", x1: 0, y1: y(t), x2: PW, y2: y(t) }),
				);
				out.push(
					text({ class: "ax-text", x: -8, y: y(t) + 3, "text-anchor": "end" }, fmt(t, unit)),
				);
			}
		}
	}
	const every = Math.ceil(xs.length / 9);
	xs.forEach((x, i) => {
		if (v === "slope" || i % every === 0 || i === xs.length - 1) {
			out.push(
				text({
					class: v === "slope" ? "ax-label" : "ax-text",
					x: xAt(i),
					y: PH + 20,
					"text-anchor": "middle",
				}, x),
			);
		}
	});
	if (v === "slope") {
		out.push(
			...[0, xs.length - 1].map((i) =>
				el("line", { class: "ax-line", x1: xAt(i), y1: -8, x2: xAt(i), y2: PH + 6 })
			),
		);
	}
	// end labels, de-overlapped vertically
	const ends = series.map((s) => {
		const last = s.values.length - 1 - [...s.values].toReversed().findIndex((x) => x != null);
		return { s, last, y: y(s.values[last]) };
	}).sort((a, b) => a.y - b.y);
	for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 13);
	series.forEach((s, k) => {
		const pts = s.values.map((val, i) => (val == null ? null : { x: xAt(i), y: y(val) })).filter(
			Boolean,
		);
		const st = Math.min(12, 2 + k);
		const g = [
			el("path", {
				class: `${cls(s)} e-line sc-draw`,
				d: v === "line" && spec.smooth
					? smooth(pts)
					: pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" "),
				pathLength: 1,
			}),
		];
		if (spec.area && v === "line") {
			g.unshift(el("path", {
				class: `ln-area${s.focal ? " is-focal" : ""}`,
				d: `${pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")} L${
					pts[pts.length - 1].x
				},${PH} L${pts[0].x},${PH} Z`,
			}));
		}
		if (v === "slope" || v === "bump" || pts.length <= 12) {
			s.values.forEach((val, i) =>
				val != null
				&& g.push(
					el("circle", {
						class: `ln-pt ${cls(s)}`,
						cx: xAt(i),
						cy: y(val),
						r: v === "bump" ? 4 : 3,
						"data-sc-tip": `${s.name} · ${xs[i]}: ${v === "bump" ? `#${val}` : fmt(val, unit)}`,
					}),
				)
			);
		}
		const e = ends.find((q) => q.s === s);
		g.push(
			text(
				{ class: `ln-label ${lblCls(s)}`, x: xAt(e.last) + 10, y: e.y + 3.5 },
				v === "slope" ? `${s.name} ${fmt(s.values[e.last], unit)}` : s.name,
			),
		);
		if (v === "slope") {
			g.push(
				text({
					class: `ln-label ${lblCls(s)}`,
					x: -10,
					y: y(s.values[0]) + 3.5,
					"text-anchor": "end",
				}, fmt(s.values[0], unit)),
			);
		}
		out.push(
			el("g", {
				class: "sc-edge",
				"data-sc-edge": `s${k}`,
				"data-sc-step": st,
				style: `--step:${st}`,
			}, g),
		);
	});
	return {
		body: out.join(""),
		viewBox: [-54, -24, PW + labelW + 70, PH + 56],
		steps: Math.min(12, 1 + series.length),
		problems,
	};
}
