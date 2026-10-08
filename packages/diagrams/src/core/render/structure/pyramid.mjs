// Pyramid (ranked hierarchy, narrow top) or funnel (wide top, values + drop-off).
import { el, text } from "../../svg.mjs";
import { group, item, itemIdProblems, LABEL } from "./common.mjs";
import { textWidth } from "../../text.mjs";
import { fmt } from "../charts/scale.mjs";

export const family = "structure";

export function render(spec) {
	const problems = [];
	const levels = spec.levels.map((l, i) => item(l, i, "l"));
	const identityProblems = itemIdProblems(levels, "levels");
	if (identityProblems.length) return { problems: identityProblems };
	const n = levels.length;
	if (n > 7) {
		problems.push({ code: "W_BUDGET", at: "levels", msg: `${n} levels`, fix: "keep ≤ 7 levels" });
	}
	const funnel = spec.variant === "funnel" || spec.type === "funnel";
	const W = 460, H = 56, gap = 6;
	const out = [];
	const minW = (i) => textWidth(levels[Math.min(i, n - 1)].label, LABEL) + 36;
	const widthAt = (i) => {
		if (funnel) {
			const vals = levels.map((l) => l.value);
			// sqrt keeps tiny tail stages legible; never narrower than the label
			if (vals.every((v) => typeof v === "number")) {
				return Math.max(minW(i), W * Math.sqrt(vals[i] / vals[0]));
			}
			return W - (i * (W - 120)) / Math.max(1, n - 1);
		}
		return 80 + ((i + 1) * (W - 80)) / n;
	};
	levels.forEach((l, i) => {
		const y = i * (H + gap);
		const wTop = funnel ? widthAt(i) : i === 0 ? 0 : widthAt(i - 1);
		const wBot = funnel
			? (i + 1 < n ? Math.max(widthAt(i + 1), minW(i)) : Math.max(widthAt(i) * 0.86, minW(i)))
			: Math.max(widthAt(i), minW(i) + 30);
		const d = `M${-wTop / 2},${y} L${wTop / 2},${y} L${wBot / 2},${y + H} L${-wBot / 2},${y + H} Z`;
		const st = Math.min(12, i + 1);
		const parts = [el("path", { class: "n-mask", d }), el("path", { class: "n-box", d })];
		parts.push(
			text({ class: "n-label", x: 0, y: y + H / 2 + 4, "text-anchor": "middle" }, l.label),
		);
		// value / sub on the right, outside the shape
		const side = Math.max(wTop, wBot) / 2 + 16;
		if (l.value !== undefined) {
			parts.push(
				text({ class: "c-val", x: side, y: y + H / 2 - 2 }, fmt(l.value, spec.unit || "")),
			);
		}
		if (
			funnel && i > 0 && typeof l.value === "number" && typeof levels[i - 1].value === "number"
			&& levels[i - 1].value
		) {
			parts.push(
				text(
					{ class: "n-sub", x: side, y: y + H / 2 + 12 },
					`${Math.round((l.value / levels[i - 1].value) * 100)}% of previous`,
				),
			);
		} else if (l.sub) {
			parts.push(
				text({ class: "n-sub", x: side, y: y + H / 2 + (l.value !== undefined ? 12 : 3) }, l.sub),
			);
		}
		out.push(
			group(`sc-node ${l.focal ? "k-focal" : "k-backend"} sc-wipe-down`, l.id, st, parts, {
				"aria-label": `${l.label}${l.value !== undefined ? ` ${l.value}` : ""}`,
			}),
		);
	});
	return {
		body: el("g", { class: "sc-nodes" }, out),
		viewBox: [-W / 2 - 32, -28, W + 240, n * (H + gap) + 48],
		steps: Math.min(12, n),
		problems,
		graph: { nodes: levels.map((l) => ({ id: l.id, label: l.label })), edges: [] },
	};
}
