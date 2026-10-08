// Wardley map: components positioned by evolution (x: genesis → commodity)
// and visibility (y: visible to the user → invisible), dependency lines,
// and dashed movement arrows for components that are evolving.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";

export const family = "chart";

const W = 640, H = 420;
const STAGES = ["Genesis", "Custom-built", "Product (+rental)", "Commodity (+utility)"];

export function render(spec) {
	const problems = [];
	const comps = spec.components.map((c, i) => ({ ...c, id: c.id || `c${i}` }));
	const byId = new Map(comps.map((c) => [c.id, c]));
	for (const c of comps) {
		if (c.evo < 0 || c.evo > 1 || c.vis < 0 || c.vis > 1) {
			problems.push({
				code: "E_SPEC",
				at: `components.${c.id}`,
				msg: "evo/vis must be within 0..1",
				fix: "evo: 0 genesis … 1 commodity; vis: 1 user-visible … 0 invisible",
			});
		}
	}
	if (comps.length > 20) {
		problems.push({
			code: "W_BUDGET",
			at: "components",
			msg: `${comps.length} components`,
			fix: "keep ≤ 20 components",
		});
	}
	const x = (e) => e * W, y = (v) => (1 - v) * H;
	const out = [];
	out.push(el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:0" }, [
		el("rect", { class: "q-frame", x: 0, y: 0, width: W, height: H }),
		...[1, 2, 3].map((k) =>
			el("line", {
				class: "ax-grid",
				x1: (k * W) / 4,
				y1: 0,
				x2: (k * W) / 4,
				y2: H,
				"stroke-dasharray": "3 4",
			})
		),
		...STAGES.map((s, k) => text({ class: "ax-text", x: (k * W) / 4 + 6, y: H + 16 }, s)),
		text({ class: "ax-label", x: W, y: H + 34, "text-anchor": "end" }, "Evolution →"),
		text({
			class: "ax-label",
			x: -12,
			y: H / 2,
			"text-anchor": "middle",
			transform: `rotate(-90 -12 ${H / 2})`,
		}, "Value chain (visible → invisible)"),
	]));
	const links = (spec.links || []).map((
		l,
		i,
	) => (Array.isArray(l) ? { from: l[0], to: l[1], i } : { ...l, i }));
	for (const l of links) {
		const a = byId.get(l.from), b = byId.get(l.to);
		if (!a || !b) {
			problems.push({
				code: "E_EDGE_NODE",
				at: `links[${l.i}]`,
				msg: `unknown component "${!a ? l.from : l.to}"`,
				fix: `use: ${[...byId.keys()].slice(0, 6).join(", ")}`,
			});
			continue;
		}
		const st = Math.min(12, 2 + Math.round((1 - Math.min(a.vis, b.vis)) * 8));
		out.push(
			el(
				"g",
				{
					class: "sc-edge ek-muted",
					"data-sc-edge": `l${l.i}`,
					"data-from": a.id,
					"data-to": b.id,
					"data-sc-step": st,
					style: `--step:${st}`,
				},
				el("path", {
					class: "e-line sc-draw wm-link",
					d: `M${x(a.evo)},${y(a.vis)} L${x(b.evo)},${y(b.vis)}`,
					pathLength: 1,
				}),
			),
		);
	}
	for (const c of comps) {
		const st = Math.min(12, 1 + Math.round((1 - c.vis) * 8));
		const cx = x(c.evo), cy = y(c.vis);
		const parts = [];
		if (c.moveTo !== undefined) {
			const tx = x(c.moveTo);
			parts.push(
				el("path", {
					class: "wm-move",
					d: `M${cx + (tx > cx ? 8 : -8)},${cy} L${tx - (tx > cx ? 8 : -8)},${cy}`,
				}),
			);
			parts.push(
				el("path", {
					class: "wm-move-head",
					d: `M${tx - (tx > cx ? 2 : -2)},${cy} L${tx - (tx > cx ? 9 : -9)},${cy - 3.5} L${
						tx - (tx > cx ? 9 : -9)
					},${cy + 3.5} Z`,
				}),
			);
			parts.push(el("circle", { class: "wm-ghost", cx: tx, cy, r: 5.5 }));
		}
		if (c.inertia) {
			parts.push(
				el("line", { class: "wm-inertia", x1: cx + 14, y1: cy - 9, x2: cx + 14, y2: cy + 9 }),
			);
		}
		parts.push(
			el("circle", {
				class: `wm-dot${c.focal ? " is-focal" : ""}${c.anchor ? " is-anchor" : ""}`,
				cx,
				cy,
				r: c.anchor ? 0 : 5.5,
			}),
		);
		const lw = textWidth(c.label, { size: 10.5, weight: 500 });
		const right = cx + lw + 14 < W;
		parts.push(
			text({
				class: `wm-label${c.focal ? " is-focal-t" : ""}${c.anchor ? " is-anchor" : ""}`,
				x: c.anchor ? cx : right ? cx + 9 : cx - 9,
				y: c.anchor ? cy + 16 : cy - 8,
				"text-anchor": c.anchor ? "middle" : right ? "start" : "end",
			}, c.label),
		);
		out.push(
			el("g", {
				class: "sc-node sc-pop",
				"data-sc-node": c.id,
				"data-sc-step": st,
				style: `--step:${st}`,
				tabindex: 0,
				role: "group",
				"aria-label": c.label,
			}, parts),
		);
	}
	return {
		body: out.join(""),
		viewBox: [-40, -24, W + 64, H + 68],
		steps: 12,
		problems,
		graph: {
			nodes: comps.map((c) => ({ id: c.id, label: c.label })),
			edges: links.map((l) => ({ id: `l${l.i}`, from: l.from, to: l.to })),
		},
	};
}
