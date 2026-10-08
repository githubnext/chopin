// Radar (series polygons on shared axes) and polar (radial bars / lollipops).
import { el, text } from "../../svg.mjs";
import { fmt, niceDomain } from "./scale.mjs";

export const family = "chart";

const R = 170;

function polar(a, r) {
	return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

export function renderRadar(spec) {
	const problems = [];
	const axes = spec.axes;
	const series = spec.series.map((s, i) => ({ ...s, i }));
	series.forEach((s) =>
		s.values.length !== axes.length
		&& problems.push({
			code: "E_SERIES_LEN",
			at: `series[${s.i}]`,
			msg: `${s.values.length} values for ${axes.length} axes`,
			fix: "one value per axis",
		})
	);
	if (problems.length) return { problems };
	if (series.length > 4) {
		problems.push({
			code: "W_BUDGET",
			at: "series",
			msg: `${series.length} series`,
			fix: "radar reads best with ≤ 3 series",
		});
	}
	const max = spec.max || niceDomain(0, Math.max(...series.flatMap((s) => s.values))).hi;
	const n = axes.length;
	const ang = (i) => (i * 2 * Math.PI) / n;
	const out = [];
	for (const f of [0.25, 0.5, 0.75, 1]) {
		out.push(
			el("path", {
				class: f === 1 ? "ax-line rd-ring" : "ax-grid rd-ring",
				d: axes.map((_, i) => {
					const p = polar(ang(i), R * f);
					return `${i ? "L" : "M"}${p.x},${p.y}`;
				}).join(" ") + " Z",
			}),
		);
	}
	out.push(text({ class: "ax-text", x: 4, y: -R - 4 }, fmt(max, spec.unit || "")));
	axes.forEach((a, i) => {
		const p = polar(ang(i), R), q = polar(ang(i), R + 16);
		out.push(el("line", { class: "ax-grid", x1: 0, y1: 0, x2: p.x, y2: p.y }));
		out.push(
			text({
				class: "c-cat",
				x: q.x,
				y: q.y + 4,
				"text-anchor": Math.abs(q.x) < 4 ? "middle" : q.x > 0 ? "start" : "end",
			}, a),
		);
	});
	const anyFocal = series.some((s) => s.focal);
	series.forEach((s, k) => {
		const d = s.values.map((v, i) => {
			const p = polar(ang(i), (R * v) / max);
			return `${i ? "L" : "M"}${p.x},${p.y}`;
		}).join(" ") + " Z";
		const cls = s.focal ? "is-focal" : anyFocal ? "is-muted" : `s-${(k % 5) + 1}`;
		const st = Math.min(12, 2 + k * 2);
		out.push(
			el("g", {
				class: "sc-edge sc-pop",
				"data-sc-edge": `s${k}`,
				"data-sc-step": st,
				style: `--step:${st}`,
			}, [
				el("path", { class: `rd-area ${cls}`, d }),
				el("path", { class: `rd-line ${cls}`, d }),
				...s.values.map((v, i) => {
					const p = polar(ang(i), (R * v) / max);
					return el("circle", {
						class: `rd-pt ${cls}`,
						cx: p.x,
						cy: p.y,
						r: 2.5,
						"data-sc-tip": `${s.name} · ${axes[i]}: ${fmt(v, spec.unit || "")}`,
					});
				}),
			]),
		);
	});
	// legend
	series.forEach((s, k) => {
		const cls = s.focal ? "is-focal" : anyFocal ? "is-muted" : `s-${(k % 5) + 1}`;
		out.push(
			el("rect", {
				class: `rd-key ${cls}`,
				x: R + 70,
				y: -R + k * 18,
				width: 12,
				height: 8,
				rx: 2,
			}),
		);
		out.push(text({ class: "lg-text", x: R + 88, y: -R + k * 18 + 8 }, s.name));
	});
	return {
		body: out.join(""),
		viewBox: [-R - 110, -R - 40, 2 * R + 300, 2 * R + 80],
		steps: Math.min(12, 2 + series.length * 2),
		problems,
	};
}

export function renderPolar(spec) {
	const problems = [];
	const data = spec.data.map((d) => (Array.isArray(d) ? { label: d[0], value: d[1] } : d));
	if (data.length > 24) {
		problems.push({
			code: "W_BUDGET",
			at: "data",
			msg: `${data.length} items`,
			fix: "keep ≤ 24 spokes",
		});
	}
	const max = spec.max || niceDomain(0, Math.max(...data.map((d) => d.value))).hi;
	const inner = 46;
	const n = data.length;
	const out = [];
	for (const f of [0.5, 1]) {
		out.push(
			el("circle", {
				class: f === 1 ? "ax-line rd-ring" : "ax-grid rd-ring",
				cx: 0,
				cy: 0,
				r: inner + (R - inner) * f,
			}),
		);
	}
	const focalSet = new Set([].concat(spec.focal || []));
	data.forEach((d, i) => {
		const a = ((i + 0.5) * 2 * Math.PI) / n;
		const r = inner + ((R - inner) * d.value) / max;
		const p0 = polar(a, inner), p1 = polar(a, r), pl = polar(a, R + 14);
		const focal = d.focal || focalSet.has(d.label);
		const st = Math.min(12, 1 + Math.floor((i * 11) / Math.max(11, n)));
		out.push(
			el("g", {
				class: `sc-fade${focal ? " k-focal" : ""}`,
				"data-sc-step": st,
				style: `--step:${st}`,
				"data-sc-tip": `${d.label}: ${fmt(d.value, spec.unit || "")}`,
			}, [
				el("line", {
					class: `pl-stem${focal ? " is-focal" : ""} sc-draw`,
					x1: p0.x,
					y1: p0.y,
					x2: p1.x,
					y2: p1.y,
					pathLength: 1,
				}),
				el("circle", {
					class: `pl-dot${focal ? " is-focal" : ""}`,
					cx: p1.x,
					cy: p1.y,
					r: focal ? 5 : 3.6,
				}),
				text({
					class: `c-cat${focal ? " is-focal-t" : ""}`,
					x: pl.x,
					y: pl.y + 3.5,
					"text-anchor": Math.abs(pl.x) < 6 ? "middle" : pl.x > 0 ? "start" : "end",
				}, d.label),
			]),
		);
	});
	if (spec.center) {
		out.push(
			text(
				{ class: "loop-center", x: 0, y: 6, "text-anchor": "middle", style: "font-size:15px" },
				spec.center,
			),
		);
	}
	return {
		body: out.join(""),
		viewBox: [-R - 120, -R - 40, 2 * R + 240, 2 * R + 80],
		steps: 12,
		problems,
	};
}
