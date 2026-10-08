// Venn: 2–3 sets with labelled overlaps.
import { el, text } from "../../svg.mjs";
import { group } from "./common.mjs";

export const family = "structure";

export function render(spec) {
	const problems = [];
	const sets = spec.sets.map((
		s,
		i,
	) => (typeof s === "string" ? { id: `s${i}`, label: s } : { id: s.id || `s${i}`, ...s }));
	if (sets.length < 2 || sets.length > 3) {
		return {
			problems: [{
				code: "E_SPEC",
				at: "sets",
				msg: "venn needs 2 or 3 sets",
				fix: "use a quadrant or matrix for more sets",
			}],
		};
	}
	const r = 120;
	const centers = sets.length === 2
		? [{ x: -r * 0.55, y: 0 }, { x: r * 0.55, y: 0 }]
		: [{ x: -r * 0.55, y: -r * 0.3 }, { x: r * 0.55, y: -r * 0.3 }, { x: 0, y: r * 0.62 }];
	const out = [];
	sets.forEach((s, i) => {
		const c = centers[i];
		const dir = {
			x: c.x === 0 ? 0 : Math.sign(c.x),
			y: sets.length === 3 && i === 2 ? 1 : sets.length === 3 ? -0.6 : 0,
		};
		const lx = c.x + dir.x * r * 0.45, ly = c.y + dir.y * r * 0.5;
		out.push(group(`sc-node venn ${s.focal ? "k-focal" : ""} vs-${i + 1}`, s.id, i + 1, [
			el("circle", { class: "venn-c", cx: c.x, cy: c.y, r }),
			text(
				{ class: "venn-label", x: lx, y: ly - (s.sub ? 4 : -4), "text-anchor": "middle" },
				s.label,
			),
			s.sub ? text({ class: "n-sub", x: lx, y: ly + 12, "text-anchor": "middle" }, s.sub) : "",
		], { "aria-label": s.label }));
	});
	const idx = new Map(sets.map((s, i) => [s.id, i]));
	(spec.overlaps || []).forEach((o, k) => {
		const ids = o.sets.map((id) => idx.get(id));
		if (ids.some((v) => v === undefined)) {
			problems.push({
				code: "E_SPEC",
				at: `overlaps[${k}]`,
				msg: "unknown set id",
				fix: `use: ${[...idx.keys()].join(", ")}`,
			});
			return;
		}
		let x = ids.reduce((s, i) => s + centers[i].x, 0) / ids.length;
		let y = ids.reduce((s, i) => s + centers[i].y, 0) / ids.length;
		if (sets.length === 3 && ids.length === 2) {
			const other = [0, 1, 2].find((i) => !ids.includes(i));
			x += (x - centers[other].x) * 0.32;
			y += (y - centers[other].y) * 0.32;
		}
		out.push(
			el("g", {
				class: `sc-enter${o.focal ? " venn-focal" : ""}`,
				"data-sc-step": sets.length + 1 + k,
				style: `--step:${sets.length + 1 + k}`,
			}, [
				text({
					class: o.focal ? "venn-ov is-focal" : "venn-ov",
					x,
					y: y + 4,
					"text-anchor": "middle",
				}, o.label),
			]),
		);
	});
	return {
		body: out.join(""),
		viewBox: [
			-r * 1.75,
			sets.length === 2 ? -r - 30 : -r * 1.4,
			r * 3.5,
			sets.length === 2 ? 2 * r + 60 : r * 3.15,
		],
		steps: sets.length + (spec.overlaps || []).length,
		problems,
		graph: { nodes: sets.map((s) => ({ id: s.id, label: s.label })), edges: [] },
	};
}
