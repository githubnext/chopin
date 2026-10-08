// Quadrant (2×2): items positioned on two axes (x, y in 0..1), or the
// consultant variant where each quadrant holds a titled list.
import { el, text } from "../../svg.mjs";
import { textWidth } from "../../text.mjs";
import { group, stepOf } from "./common.mjs";

export const family = "structure";

const S = 420;

export function render(spec) {
	const problems = [];
	const out = [];
	const nodes = [];
	const consultant = spec.variant === "consultant" || spec.type === "quadrant-consultant";
	const q = spec.quadrants || [];
	const half = S / 2;
	// frame + axes
	out.push(el("g", { class: "sc-fade", "data-sc-step": 1, style: "--step:0" }, [
		el("rect", { class: "q-frame", x: 0, y: 0, width: S, height: S }),
		el("line", { class: "ax-line", x1: half, y1: 0, x2: half, y2: S }),
		el("line", { class: "ax-line", x1: 0, y1: half, x2: S, y2: half }),
		spec.x ? text({ class: "ax-text", x: 0, y: S + 16 }, spec.x.low || "") : "",
		spec.x
			? text({ class: "ax-text", x: S, y: S + 16, "text-anchor": "end" }, spec.x.high || "")
			: "",
		spec.x && spec.x.label
			? text(
				{ class: "ax-label", x: half, y: S + 34, "text-anchor": "middle" },
				`${spec.x.label} →`,
			)
			: "",
		spec.y ? text({ class: "ax-text", x: -8, y: S, "text-anchor": "end" }, spec.y.low || "") : "",
		spec.y ? text({ class: "ax-text", x: -8, y: 8, "text-anchor": "end" }, spec.y.high || "") : "",
		spec.y && spec.y.label
			? text({
				class: "ax-label",
				x: -24,
				y: half,
				"text-anchor": "middle",
				transform: `rotate(-90 -24 ${half})`,
			}, `${spec.y.label} →`)
			: "",
	]));
	// quadrant order: TL, TR, BL, BR
	const corners = [[0, 0], [half, 0], [0, half], [half, half]];
	q.forEach((qq, i) => {
		const o = typeof qq === "string" ? { label: qq } : qq;
		const [x, y] = corners[i];
		const parts = [];
		if (o.focal) {
			parts.push(
				el("rect", { class: "q-focal", x: x + 1, y: y + 1, width: half - 2, height: half - 2 }),
			);
		}
		parts.push(
			text({
				class: consultant ? "q-title-big" : "q-title",
				x: x + 14,
				y: y + (consultant ? 34 : 22),
			}, consultant ? o.label : o.label.toUpperCase()),
		);
		if (consultant) {
			(o.items || []).slice(0, 6).forEach((it, k) =>
				parts.push(text({ class: "q-item", x: x + 14, y: y + 62 + k * 18 }, `· ${it}`))
			);
			if ((o.items || []).length > 6) {
				problems.push({
					code: "W_BUDGET",
					at: `quadrants[${i}]`,
					msg: "more than 6 items",
					fix: "keep ≤ 6 per quadrant",
				});
			}
		}
		const id = `q${i}`;
		nodes.push({ id, label: o.label });
		out.push(
			group(`sc-node quad${o.focal ? " k-focal" : ""}`, id, 2 + i, parts, {
				"aria-label": o.label,
			}),
		);
	});
	// plotted items
	(spec.items || []).forEach((it, i) => {
		const px = it.x * S, py = (1 - it.y) * S;
		if (it.x < 0 || it.x > 1 || it.y < 0 || it.y > 1) {
			problems.push({
				code: "E_SPEC",
				at: `items[${i}]`,
				msg: "x/y must be within 0..1",
				fix: "scale positions to 0..1",
			});
		}
		const right = px < S - textWidth(it.label, { size: 10.5, weight: 500 }) - 16;
		const id = it.id || `p${i}`;
		nodes.push({ id, label: it.label });
		const st = 6 + stepOf(i, (spec.items || []).length) / 2;
		out.push(
			group(`sc-node q-pt sc-pop${it.focal ? " k-focal" : ""}`, id, Math.min(12, Math.round(st)), [
				el("circle", { class: "q-dot", cx: px, cy: py, r: it.focal ? 6 : 4.5 }),
				text({
					class: "q-pt-label",
					x: right ? px + 10 : px - 10,
					y: py + 4,
					"text-anchor": right ? "start" : "end",
				}, it.label),
			], { "aria-label": it.label }),
		);
	});
	if (!consultant && (spec.items || []).length > 12) {
		problems.push({
			code: "W_BUDGET",
			at: "items",
			msg: "more than 12 points",
			fix: "label only the points that matter",
		});
	}
	return {
		body: out.join(""),
		viewBox: [-60, -24, S + 96, S + 72],
		steps: 12,
		problems,
		graph: { nodes, edges: [] },
	};
}
