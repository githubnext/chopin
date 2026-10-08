// User journey: stages across the top, steps under them, and an emotion
// curve (score -2..+2) that dips at pain points. Motion: stages, then the
// curve draws, then the points pop.
import { el, text } from "../../svg.mjs";
import { textWidth, wrap } from "../../text.mjs";

export const family = "lanes";

export function render(spec) {
	const problems = [];
	const steps = [];
	spec.stages.forEach((st, si) =>
		(st.steps || []).forEach((s, k) =>
			steps.push({
				...(typeof s === "string" ? { label: s, score: 0 } : s),
				stage: si,
				id: `s${si}_${k}`,
			})
		)
	);
	if (!steps.length) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "stages",
				msg: "no steps",
				fix: "give each stage steps:[{label,score}]",
			}],
		};
	}
	if (steps.length > 14) {
		problems.push({
			code: "W_BUDGET",
			at: "stages",
			msg: `${steps.length} steps`,
			fix: "keep ≤ 14 steps",
		});
	}
	const COL = Math.max(
		104,
		Math.min(
			150,
			Math.max(...steps.map((s) => textWidth(s.label, { size: 10.5, weight: 500 }) * 0.6)) + 40,
		),
	);
	const curveTop = 70, curveH = 150;
	const y = (score) => curveTop + ((2 - Math.max(-2, Math.min(2, score ?? 0))) / 4) * curveH;
	const out = [];
	let col = 0;
	spec.stages.forEach((st, si) => {
		const n = Math.max(1, (st.steps || []).length);
		const x = col * COL, w = n * COL;
		out.push(el("g", { class: "sc-fade", "data-sc-step": 1, style: `--step:${si}` }, [
			el("rect", {
				class: si % 2 ? "jr-band alt" : "jr-band",
				x,
				y: 0,
				width: w,
				height: curveTop + curveH + 114,
			}),
			text({ class: "jr-stage", x: x + 12, y: 22 }, st.label.toUpperCase()),
			st.sub ? text({ class: "n-sub", x: x + 12, y: 38 }, st.sub) : "",
		]));
		col += n;
	});
	// neutral line + emotion curve (smooth cubic through points)
	const pts = steps.map((s, i) => ({ x: i * COL + COL / 2, y: y(s.score) }));
	let d = `M${pts[0].x},${pts[0].y}`;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i];
		const mx = (a.x + b.x) / 2;
		d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
	}
	out.push(
		el("line", {
			class: "ax-grid",
			x1: 0,
			y1: y(0),
			x2: col * COL,
			y2: y(0),
			"stroke-dasharray": "3 4",
		}),
	);
	out.push(text({ class: "ax-text", x: -8, y: y(2) + 3, "text-anchor": "end" }, "+"));
	out.push(text({ class: "ax-text", x: -8, y: y(0) + 3, "text-anchor": "end" }, "0"));
	out.push(text({ class: "ax-text", x: -8, y: y(-2) + 3, "text-anchor": "end" }, "−"));
	out.push(
		el("g", {
			class: "sc-edge ek-default",
			"data-sc-edge": "curve",
			"data-sc-step": 3,
			style: "--step:3",
		}, el("path", { class: "e-line sc-draw jr-curve", d, pathLength: 1 })),
	);
	steps.forEach((s, i) => {
		const p = pts[i];
		const pain = s.pain || (s.score ?? 0) <= -2;
		const st = Math.min(12, 4 + Math.floor((i * 8) / Math.max(8, steps.length)));
		const lines = wrap(s.label, COL - 16, { size: 10.5, weight: 500 }).slice(0, 2);
		const below = curveTop + curveH + 44;
		const g = [
			el("circle", {
				class: `jr-dot${pain ? " is-pain" : ""}${s.focal ? " is-focal" : ""}`,
				cx: p.x,
				cy: p.y,
				r: pain || s.focal ? 6 : 4.5,
			}),
			...lines.map((l, k) =>
				text({ class: "jr-step", x: p.x, y: below + k * 13, "text-anchor": "middle" }, l)
			),
		];
		// notes sit on the open side of the curve: under a dip, over a peak or a slope
		if (s.note) {
			const prev = pts[i - 1] || p, next = pts[i + 1] || p;
			const dip = p.y >= prev.y && p.y >= next.y && (p.y > prev.y || p.y > next.y);
			g.push(
				text({
					class: `jr-note${pain ? " is-pain" : ""}`,
					x: p.x,
					y: dip ? p.y + 22 : p.y - 14,
					"text-anchor": "middle",
				}, s.note),
			);
		}
		out.push(
			el("g", {
				class: `sc-node sc-pop${pain ? " k-focal" : ""}`,
				"data-sc-node": s.id,
				"data-sc-step": st,
				style: `--step:${st}`,
				tabindex: 0,
				role: "group",
				"aria-label": `${s.label}${pain ? " (pain point)" : ""}`,
			}, g),
		);
	});
	return {
		body: out.join(""),
		viewBox: [-32, -16, col * COL + 56, curveTop + curveH + 146],
		steps: 12,
		problems,
		graph: { nodes: steps.map((s) => ({ id: s.id, label: s.label })), edges: [] },
	};
}
