// Layer stack: full-width bands, top = closest to the user. Items show as
// chips inside each band. Builds bottom-up (foundation first).
import { el, text } from "../../svg.mjs";
import { ceil4, textWidth } from "../../text.mjs";
import { bounds, group, item } from "./common.mjs";

export const family = "structure";

const CHIP = { size: 10 };

export function render(spec) {
	const problems = [];
	const layers = spec.layers.map((l, i) => item(l, i, "l"));
	if (layers.length > 7) {
		problems.push({
			code: "W_BUDGET",
			at: "layers",
			msg: `${layers.length} layers`,
			fix: "keep ≤ 7 layers",
		});
	}
	const labelW = ceil4(
		Math.max(...layers.map((l) =>
			Math.max(
				textWidth(l.label, { size: 12, weight: 600 }),
				l.sub ? textWidth(l.sub, { size: 9, mono: true }) : 0,
			)
		)) + 36,
	);
	const chipsW = Math.max(
		0,
		...layers.map((l) =>
			(l.items || []).reduce((s, c) => s + textWidth(c, CHIP) + 24, 0)
			+ 8 * Math.max(0, (l.items || []).length - 1)
		),
	);
	const W = Math.max(560, labelW + chipsW + 40);
	const H = 58;
	const gap = 8;
	const n = layers.length;
	const out = layers.map((l, i) => {
		const y = i * (H + gap);
		const st = Math.min(12, n - i);
		const parts = [
			el("rect", { class: "n-mask", x: 0, y, width: W, height: H, rx: 6 }),
			el("rect", { class: "n-box", x: 0, y, width: W, height: H, rx: 6 }),
			text({ class: "n-label", x: 16, y: y + (l.sub ? 25 : 33) }, l.label),
		];
		if (l.sub) parts.push(text({ class: "n-sub", x: 16, y: y + 41 }, l.sub));
		let cx = labelW + 8;
		for (const c of l.items || []) {
			const cw = textWidth(c, CHIP) + 20;
			parts.push(
				el("rect", { class: "chip", x: cx, y: y + H / 2 - 12, width: cw, height: 24, rx: 4 }),
			);
			parts.push(
				text(
					{ class: "chip-text", x: cx + cw / 2, y: y + H / 2 + 3.5, "text-anchor": "middle" },
					c,
				),
			);
			cx += cw + 8;
		}
		return group(
			`sc-node ${l.focal ? "k-focal" : l.kind ? `k-${l.kind}` : "k-backend"}`,
			l.id,
			st,
			parts,
			{ "aria-label": `${l.label}${l.items ? `: ${l.items.join(", ")}` : ""}` },
		);
	});
	return {
		body: el("g", { class: "sc-nodes" }, out),
		viewBox: bounds([{ x: 0, y: 0, w: W, h: n * (H + gap) - gap }], 28),
		steps: Math.min(12, n),
		problems,
		graph: { nodes: layers.map((l) => ({ id: l.id, label: l.label })), edges: [] },
	};
}
